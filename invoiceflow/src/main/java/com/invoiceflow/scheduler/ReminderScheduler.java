package com.invoiceflow.scheduler;

import com.invoiceflow.email.EmailService;
import com.invoiceflow.invoice.Invoice;
import com.invoiceflow.invoice.InvoiceRepository;
import com.invoiceflow.invoice.InvoiceStatus;
import com.invoiceflow.user.Plan;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Arrays;

@Component
public class ReminderScheduler {

    private static final Logger log = LoggerFactory.getLogger(ReminderScheduler.class);
    // Don't spam: only send a reminder if none sent in the last 3 days
    private static final long REMINDER_COOLDOWN_DAYS = 3;

    private final InvoiceRepository invoiceRepository;
    private final EmailService emailService;

    public ReminderScheduler(InvoiceRepository invoiceRepository, EmailService emailService) {
        this.invoiceRepository = invoiceRepository;
        this.emailService = emailService;
    }

    // Runs daily at 09:00 UTC
    @Scheduled(cron = "0 0 9 * * *")
    @Transactional
    public void sendOverdueReminders() {
        LocalDate today = LocalDate.now();

        // Mark SENT invoices whose due date has passed as OVERDUE
        List<InvoiceStatus> activeStatuses = Arrays.asList(InvoiceStatus.SENT, InvoiceStatus.OVERDUE);
        List<Invoice> nowOverdue = invoiceRepository.findOverdue(activeStatuses, today);
        nowOverdue.forEach(inv -> {
            if (inv.getStatus() == InvoiceStatus.SENT) {
                inv.setStatus(InvoiceStatus.OVERDUE);
                invoiceRepository.save(inv);
            }
        });

        // Send reminders for PRO/AGENCY users (autoReminders feature)
        List<Invoice> forReminder = invoiceRepository.findSentForAutoReminder(
                activeStatuses, Arrays.asList(Plan.PRO, Plan.AGENCY));
        forReminder.stream()
                .filter(inv -> inv.getDueDate().isBefore(today) || inv.getDueDate().isEqual(today))
                .filter(this::cooldownPassed)
                .forEach(inv -> {
                    emailService.sendReminder(inv);
                    inv.setLastReminderSent(Instant.now());
                    invoiceRepository.save(inv);
                    log.info("Reminder queued for invoice {} user {}", inv.getInvoiceNumber(),
                            inv.getUser().getEmail());
                });
    }

    private boolean cooldownPassed(Invoice inv) {
        if (inv.getLastReminderSent() == null) return true;
        return ChronoUnit.DAYS.between(inv.getLastReminderSent(), Instant.now()) >= REMINDER_COOLDOWN_DAYS;
    }
}
