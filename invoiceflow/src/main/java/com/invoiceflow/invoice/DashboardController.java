package com.invoiceflow.invoice;

import com.invoiceflow.user.User;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/dashboard")
public class DashboardController {

    private final InvoiceRepository invoiceRepository;

    public DashboardController(InvoiceRepository invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }

    public record DashboardStats(
            BigDecimal totalRevenue,
            BigDecimal outstanding,
            BigDecimal overdue,
            long draftCount,
            long sentCount,
            long overdueCount,
            long paidCount,
            String plan) {}

    @GetMapping
    public DashboardStats stats(@AuthenticationPrincipal User user) {
        List<Invoice> all = invoiceRepository.findAllByUserIdOrderByCreatedAtDesc(user.getId());

        BigDecimal revenue = sum(all, InvoiceStatus.PAID);
        BigDecimal outstanding = sum(all, InvoiceStatus.SENT);
        BigDecimal overdue = sum(all, InvoiceStatus.OVERDUE);

        LocalDate today = LocalDate.now();
        // promote in-memory for display accuracy (scheduler runs once daily)
        long overdueCount = all.stream()
                .filter(i -> i.getStatus() == InvoiceStatus.SENT && i.getDueDate().isBefore(today))
                .count() + all.stream().filter(i -> i.getStatus() == InvoiceStatus.OVERDUE).count();

        return new DashboardStats(
                revenue,
                outstanding,
                overdue,
                count(all, InvoiceStatus.DRAFT),
                count(all, InvoiceStatus.SENT),
                overdueCount,
                count(all, InvoiceStatus.PAID),
                user.getPlan().name());
    }

    private BigDecimal sum(List<Invoice> invoices, InvoiceStatus status) {
        return invoices.stream()
                .filter(i -> i.getStatus() == status)
                .map(Invoice::total)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    private long count(List<Invoice> invoices, InvoiceStatus status) {
        return invoices.stream().filter(i -> i.getStatus() == status).count();
    }
}
