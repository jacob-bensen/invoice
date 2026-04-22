package com.invoiceflow.invoice;

import com.invoiceflow.client.ClientRepository;
import com.invoiceflow.common.PlanLimitException;
import com.invoiceflow.email.EmailService;
import com.invoiceflow.pdf.PdfService;
import com.invoiceflow.user.User;
import jakarta.validation.Valid;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.YearMonth;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

@RestController
@RequestMapping("/api/invoices")
public class InvoiceController {

    private final InvoiceRepository invoiceRepository;
    private final ClientRepository clientRepository;
    private final PdfService pdfService;
    private final EmailService emailService;

    public InvoiceController(InvoiceRepository invoiceRepository,
                              ClientRepository clientRepository,
                              PdfService pdfService,
                              EmailService emailService) {
        this.invoiceRepository = invoiceRepository;
        this.clientRepository = clientRepository;
        this.pdfService = pdfService;
        this.emailService = emailService;
    }

    // ---- DTOs ----

    public record LineItemRequest(
            @NotBlank String description,
            @NotNull @Positive BigDecimal quantity,
            @NotNull @Positive BigDecimal unitPrice,
            int sortOrder) {}

    public record InvoiceRequest(
            @NotNull Long clientId,
            @NotBlank String invoiceNumber,
            @NotNull @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate issueDate,
            @NotNull @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dueDate,
            String currency,
            String notes,
            @NotNull List<LineItemRequest> lineItems) {}

    public record LineItemResponse(Long id, String description, BigDecimal quantity,
                                   BigDecimal unitPrice, BigDecimal total, int sortOrder) {}

    public record InvoiceResponse(Long id, Long clientId, String clientName, String invoiceNumber,
                                  String status, LocalDate issueDate, LocalDate dueDate,
                                  String currency, String notes, BigDecimal total,
                                  String stripePaymentLink, List<LineItemResponse> lineItems) {}

    private LineItemResponse toDto(LineItem li) {
        return new LineItemResponse(li.getId(), li.getDescription(), li.getQuantity(),
                li.getUnitPrice(), li.total(), li.getSortOrder());
    }

    private InvoiceResponse toDto(Invoice inv) {
        return new InvoiceResponse(
                inv.getId(), inv.getClient().getId(), inv.getClient().getName(),
                inv.getInvoiceNumber(), inv.getStatus().name(),
                inv.getIssueDate(), inv.getDueDate(), inv.getCurrency(),
                inv.getNotes(), inv.total(), inv.getStripePaymentLink(),
                inv.getLineItems().stream().map(this::toDto).toList());
    }

    // ---- Endpoints ----

    @GetMapping
    public List<InvoiceResponse> list(@AuthenticationPrincipal User user) {
        return invoiceRepository.findAllByUserIdOrderByCreatedAtDesc(user.getId())
                .stream().map(this::toDto).toList();
    }

    @PostMapping
    public ResponseEntity<?> create(@AuthenticationPrincipal User user,
                                     @Valid @RequestBody InvoiceRequest req) {
        YearMonth now = YearMonth.now(ZoneOffset.UTC);
        Instant start = now.atDay(1).atStartOfDay().toInstant(ZoneOffset.UTC);
        Instant end = now.plusMonths(1).atDay(1).atStartOfDay().toInstant(ZoneOffset.UTC);
        long monthCount = invoiceRepository.countInPeriod(user.getId(), start, end);
        if (monthCount >= user.getPlan().maxInvoicesPerMonth) {
            throw new PlanLimitException("Monthly invoice limit reached. Please upgrade your plan.");
        }
        if (invoiceRepository.existsByUserIdAndInvoiceNumber(user.getId(), req.invoiceNumber())) {
            return ResponseEntity.badRequest().body("Invoice number already exists");
        }
        var client = clientRepository.findByIdAndUserId(req.clientId(), user.getId())
                .orElse(null);
        if (client == null) {
            return ResponseEntity.badRequest().body("Client not found");
        }

        var invoice = new Invoice();
        invoice.setUser(user);
        invoice.setClient(client);
        invoice.setInvoiceNumber(req.invoiceNumber());
        invoice.setIssueDate(req.issueDate());
        invoice.setDueDate(req.dueDate());
        invoice.setCurrency(req.currency() != null ? req.currency() : "USD");
        invoice.setNotes(req.notes());

        for (int i = 0; i < req.lineItems().size(); i++) {
            var li = req.lineItems().get(i);
            var lineItem = new LineItem();
            lineItem.setInvoice(invoice);
            lineItem.setDescription(li.description());
            lineItem.setQuantity(li.quantity());
            lineItem.setUnitPrice(li.unitPrice());
            lineItem.setSortOrder(li.sortOrder() != 0 ? li.sortOrder() : i);
            invoice.getLineItems().add(lineItem);
        }

        return ResponseEntity.ok(toDto(invoiceRepository.save(invoice)));
    }

    @GetMapping("/{id}")
    public ResponseEntity<InvoiceResponse> get(@AuthenticationPrincipal User user, @PathVariable Long id) {
        return invoiceRepository.findByIdAndUserId(id, user.getId())
                .map(inv -> ResponseEntity.ok(toDto(inv)))
                .orElse(ResponseEntity.notFound().build());
    }

    @PutMapping("/{id}")
    public ResponseEntity<?> update(@AuthenticationPrincipal User user,
                                     @PathVariable Long id,
                                     @Valid @RequestBody InvoiceRequest req) {
        return invoiceRepository.findByIdAndUserId(id, user.getId())
                .map(inv -> {
                    if (inv.getStatus() == InvoiceStatus.PAID) {
                        return ResponseEntity.badRequest().<InvoiceResponse>body(null);
                    }
                    var client = clientRepository.findByIdAndUserId(req.clientId(), user.getId()).orElse(null);
                    if (client == null) return ResponseEntity.badRequest().<InvoiceResponse>body(null);

                    inv.setClient(client);
                    inv.setIssueDate(req.issueDate());
                    inv.setDueDate(req.dueDate());
                    inv.setCurrency(req.currency() != null ? req.currency() : "USD");
                    inv.setNotes(req.notes());
                    inv.getLineItems().clear();
                    for (int i = 0; i < req.lineItems().size(); i++) {
                        var li = req.lineItems().get(i);
                        var lineItem = new LineItem();
                        lineItem.setInvoice(inv);
                        lineItem.setDescription(li.description());
                        lineItem.setQuantity(li.quantity());
                        lineItem.setUnitPrice(li.unitPrice());
                        lineItem.setSortOrder(li.sortOrder() != 0 ? li.sortOrder() : i);
                        inv.getLineItems().add(lineItem);
                    }
                    return ResponseEntity.ok(toDto(invoiceRepository.save(inv)));
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/send")
    public ResponseEntity<?> send(@AuthenticationPrincipal User user, @PathVariable Long id) {
        return invoiceRepository.findByIdAndUserId(id, user.getId())
                .map(inv -> {
                    byte[] pdf = pdfService.generate(inv);
                    emailService.sendInvoice(inv, pdf);
                    inv.setStatus(InvoiceStatus.SENT);
                    invoiceRepository.save(inv);
                    return ResponseEntity.ok(toDto(inv));
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping("/{id}/pdf")
    public ResponseEntity<byte[]> downloadPdf(@AuthenticationPrincipal User user, @PathVariable Long id) {
        return invoiceRepository.findByIdAndUserId(id, user.getId())
                .map(inv -> {
                    byte[] pdf = pdfService.generate(inv);
                    return ResponseEntity.ok()
                            .header(HttpHeaders.CONTENT_DISPOSITION,
                                    "attachment; filename=\"invoice-" + inv.getInvoiceNumber() + ".pdf\"")
                            .contentType(MediaType.APPLICATION_PDF)
                            .body(pdf);
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@AuthenticationPrincipal User user, @PathVariable Long id) {
        return invoiceRepository.findByIdAndUserId(id, user.getId())
                .map(inv -> {
                    if (inv.getStatus() == InvoiceStatus.PAID) {
                        return ResponseEntity.badRequest().body("Cannot delete a paid invoice");
                    }
                    invoiceRepository.delete(inv);
                    return ResponseEntity.noContent().build();
                })
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
