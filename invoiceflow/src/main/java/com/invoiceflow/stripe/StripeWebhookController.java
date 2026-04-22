package com.invoiceflow.stripe;

import com.invoiceflow.config.AppProperties;
import com.invoiceflow.invoice.Invoice;
import com.invoiceflow.invoice.InvoiceRepository;
import com.invoiceflow.invoice.InvoiceStatus;
import com.invoiceflow.user.Plan;
import com.invoiceflow.user.SubscriptionStatus;
import com.invoiceflow.user.UserRepository;
import com.stripe.exception.SignatureVerificationException;
import com.stripe.model.*;
import com.stripe.model.checkout.Session;
import com.stripe.net.Webhook;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/stripe")
public class StripeWebhookController {

    private static final Logger log = LoggerFactory.getLogger(StripeWebhookController.class);

    private final AppProperties props;
    private final UserRepository userRepository;
    private final InvoiceRepository invoiceRepository;

    public StripeWebhookController(AppProperties props,
                                    UserRepository userRepository,
                                    InvoiceRepository invoiceRepository) {
        this.props = props;
        this.userRepository = userRepository;
        this.invoiceRepository = invoiceRepository;
    }

    @PostMapping("/webhook")
    public ResponseEntity<String> handle(@RequestBody String payload,
                                          @RequestHeader("Stripe-Signature") String sig) {
        Event event;
        try {
            event = Webhook.constructEvent(payload, sig, props.getStripe().getWebhookSecret());
        } catch (SignatureVerificationException e) {
            log.warn("Invalid Stripe signature");
            return ResponseEntity.badRequest().body("invalid signature");
        }

        switch (event.getType()) {
            case "checkout.session.completed" -> handleCheckoutCompleted(event);
            case "customer.subscription.updated" -> handleSubUpdated(event);
            case "customer.subscription.deleted" -> handleSubDeleted(event);
            case "payment_link.payment_completed"  -> handlePaymentLinkCompleted(event);
            default -> log.debug("Unhandled Stripe event: {}", event.getType());
        }
        return ResponseEntity.ok("ok");
    }

    private void handleCheckoutCompleted(Event event) {
        var session = (Session) event.getDataObjectDeserializer().getObject().orElse(null);
        if (session == null) return;

        String userId = session.getMetadata().get("userId");
        if (userId == null) return;

        userRepository.findById(Long.parseLong(userId)).ifPresent(user -> {
            user.setStripeSubId(session.getSubscription());
            user.setSubStatus(SubscriptionStatus.ACTIVE);
            // Plan determined by subscription update event; set SOLO as minimum
            if (user.getPlan() == Plan.FREE) user.setPlan(Plan.SOLO);
            userRepository.save(user);
        });
    }

    private void handleSubUpdated(Event event) {
        var sub = (Subscription) event.getDataObjectDeserializer().getObject().orElse(null);
        if (sub == null) return;

        userRepository.findByStripeSubId(sub.getId()).ifPresent(user -> {
            user.setSubStatus(mapSubStatus(sub.getStatus()));
            // Map price to plan
            sub.getItems().getData().stream().findFirst().ifPresent(item -> {
                String priceId = item.getPrice().getId();
                Plan plan = planFromPriceId(priceId);
                if (plan != null) user.setPlan(plan);
            });
            userRepository.save(user);
        });
    }

    private void handleSubDeleted(Event event) {
        var sub = (Subscription) event.getDataObjectDeserializer().getObject().orElse(null);
        if (sub == null) return;

        userRepository.findByStripeSubId(sub.getId()).ifPresent(user -> {
            user.setPlan(Plan.FREE);
            user.setSubStatus(SubscriptionStatus.CANCELLED);
            user.setStripeSubId(null);
            userRepository.save(user);
        });
    }

    private void handlePaymentLinkCompleted(Event event) {
        // Mark invoice as PAID when customer pays via Stripe payment link
        var obj = event.getDataObjectDeserializer().getObject().orElse(null);
        if (!(obj instanceof PaymentIntent pi)) return;

        String invoiceId = pi.getMetadata().get("invoiceId");
        if (invoiceId == null) return;

        invoiceRepository.findById(Long.parseLong(invoiceId)).ifPresent(inv -> {
            inv.setStatus(InvoiceStatus.PAID);
            invoiceRepository.save(inv);
            log.info("Invoice {} marked PAID via Stripe payment link", inv.getInvoiceNumber());
        });
    }

    private SubscriptionStatus mapSubStatus(String status) {
        return switch (status) {
            case "active"   -> SubscriptionStatus.ACTIVE;
            case "past_due" -> SubscriptionStatus.PAST_DUE;
            case "trialing" -> SubscriptionStatus.TRIALING;
            default         -> SubscriptionStatus.CANCELLED;
        };
    }

    private Plan planFromPriceId(String priceId) {
        var stripe = props.getStripe();
        if (priceId.equals(stripe.getPriceIdSolo()))   return Plan.SOLO;
        if (priceId.equals(stripe.getPriceIdPro()))    return Plan.PRO;
        if (priceId.equals(stripe.getPriceIdAgency())) return Plan.AGENCY;
        return null;
    }
}
