package com.invoiceflow.stripe;

import com.invoiceflow.config.AppProperties;
import com.invoiceflow.invoice.InvoiceRepository;
import com.invoiceflow.user.Plan;
import com.invoiceflow.user.User;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/stripe")
public class StripeController {

    private final StripeService stripeService;
    private final InvoiceRepository invoiceRepository;
    private final AppProperties props;

    public StripeController(StripeService stripeService,
                             InvoiceRepository invoiceRepository,
                             AppProperties props) {
        this.stripeService = stripeService;
        this.invoiceRepository = invoiceRepository;
        this.props = props;
    }

    public record CheckoutRequest(@NotBlank String plan) {}

    @PostMapping("/checkout")
    public ResponseEntity<?> checkout(@AuthenticationPrincipal User user,
                                       @Valid @RequestBody CheckoutRequest req) {
        Plan targetPlan;
        try {
            targetPlan = Plan.valueOf(req.plan().toUpperCase());
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body("Invalid plan: " + req.plan());
        }
        if (targetPlan == Plan.FREE) {
            return ResponseEntity.badRequest().body("Cannot checkout FREE plan");
        }
        try {
            String url = stripeService.createCheckoutSession(user, targetPlan,
                    props.getBaseUrl() + "/billing/success",
                    props.getBaseUrl() + "/billing/cancel");
            return ResponseEntity.ok(Map.of("checkoutUrl", url));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body("Stripe error: " + e.getMessage());
        }
    }

    @PostMapping("/invoices/{id}/payment-link")
    public ResponseEntity<?> createPaymentLink(@AuthenticationPrincipal User user,
                                                @PathVariable Long id) {
        return invoiceRepository.findByIdAndUserId(id, user.getId())
                .map(inv -> {
                    try {
                        String link = stripeService.createPaymentLink(inv);
                        inv.setStripePaymentLink(link);
                        invoiceRepository.save(inv);
                        return ResponseEntity.ok(Map.of("paymentLink", link));
                    } catch (Exception e) {
                        return ResponseEntity.internalServerError()
                                .<Map<String, String>>body(Map.of("error", e.getMessage()));
                    }
                })
                .orElse(ResponseEntity.notFound().build());
    }
}
