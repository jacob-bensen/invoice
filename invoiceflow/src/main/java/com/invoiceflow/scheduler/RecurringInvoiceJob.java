package com.invoiceflow.scheduler;

import com.invoiceflow.invoice.Invoice;
import com.invoiceflow.invoice.InvoiceRepository;
import com.invoiceflow.invoice.InvoiceStatus;
import com.invoiceflow.invoice.LineItem;
import com.invoiceflow.invoice.RecurrenceFrequency;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;

/**
 * Clones recurring invoices on their scheduled day.
 * <p>
 * Runs daily at 08:00 UTC — before the reminder scheduler at 09:00 UTC so a
 * cloned DRAFT isn't eligible for reminders in the same cycle (reminders only
 * fire for SENT/OVERDUE anyway, but the ordering keeps the two jobs logically
 * independent).
 */
@Component
public class RecurringInvoiceJob {

    private static final Logger log = LoggerFactory.getLogger(RecurringInvoiceJob.class);

    private final InvoiceRepository invoiceRepository;
    private final Clock clock;

    public RecurringInvoiceJob(InvoiceRepository invoiceRepository, Clock clock) {
        this.invoiceRepository = invoiceRepository;
        this.clock = clock;
    }

    @Scheduled(cron = "0 0 8 * * *")
    @Transactional
    public void generateDueInvoices() {
        int created = generateDueInvoices(clock.instant());
        if (created > 0) {
            log.info("RecurringInvoiceJob: generated {} recurring invoice(s)", created);
        }
    }

    /** Returns the number of invoices cloned. Exposed for tests. */
    @Transactional
    public int generateDueInvoices(Instant asOf) {
        List<Invoice> due = invoiceRepository.findDueForRecurrence(asOf);
        int created = 0;
        for (Invoice template : due) {
            try {
                cloneOne(template, asOf);
                created++;
            } catch (RuntimeException ex) {
                log.error("Failed to clone recurring invoice {}", template.getId(), ex);
            }
        }
        return created;
    }

    private void cloneOne(Invoice template, Instant asOf) {
        RecurrenceFrequency frequency = template.getRecurrenceFrequency();
        if (frequency == null) {
            template.setRecurrenceActive(false);
            invoiceRepository.save(template);
            return;
        }

        Invoice clone = new Invoice();
        clone.setUser(template.getUser());
        clone.setClient(template.getClient());
        clone.setStatus(InvoiceStatus.DRAFT);
        clone.setCurrency(template.getCurrency());
        clone.setNotes(template.getNotes());

        LocalDate today = LocalDate.ofInstant(asOf, ZoneOffset.UTC);
        long originalTerm = ChronoUnit.DAYS.between(template.getIssueDate(), template.getDueDate());
        if (originalTerm < 0) originalTerm = 0;
        clone.setIssueDate(today);
        clone.setDueDate(today.plusDays(originalTerm));

        clone.setInvoiceNumber(nextInvoiceNumber(template));
        clone.setRecurrenceSourceId(template.getId());

        for (LineItem sourceLi : template.getLineItems()) {
            LineItem li = new LineItem();
            li.setInvoice(clone);
            li.setDescription(sourceLi.getDescription());
            li.setQuantity(sourceLi.getQuantity());
            li.setUnitPrice(sourceLi.getUnitPrice());
            li.setSortOrder(sourceLi.getSortOrder());
            clone.getLineItems().add(li);
        }

        invoiceRepository.save(clone);

        // Advance the template's next-run marker so we don't re-clone until the
        // next cycle. Loop to catch up if the scheduler missed days (e.g. after
        // an outage) — never clones more than once per invocation, though.
        Instant nextRun = frequency.advance(template.getRecurrenceNextRun() != null
                ? template.getRecurrenceNextRun() : asOf);
        while (!nextRun.isAfter(asOf)) {
            nextRun = frequency.advance(nextRun);
        }
        template.setRecurrenceNextRun(nextRun);
        invoiceRepository.save(template);
    }

    private String nextInvoiceNumber(Invoice template) {
        String base = template.getInvoiceNumber();
        String candidate = base + "-" + LocalDate.ofInstant(clock.instant(), ZoneOffset.UTC);
        int suffix = 1;
        while (invoiceRepository.existsByUserIdAndInvoiceNumber(template.getUser().getId(), candidate)) {
            candidate = base + "-" + LocalDate.ofInstant(clock.instant(), ZoneOffset.UTC) + "-" + suffix;
            suffix++;
        }
        return candidate;
    }
}
