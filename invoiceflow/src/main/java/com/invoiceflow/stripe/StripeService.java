package com.invoiceflow.stripe;

import com.invoiceflow.config.AppProperties;
import com.invoiceflow.user.Plan;
import com.invoiceflow.user.User;
import com.invoiceflow.user.UserRepository;
import com.stripe.Stripe;
import com.stripe.model.Customer;
import com.stripe.model.PaymentLink;
import com.stripe.model.checkout.Session;
import com.stripe.param.CustomerCreateParams;
import com.stripe.param.PaymentLinkCreateParams;
import com.stripe.param.checkout.SessionCreateParams;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Service;

import java.util.Map;

@Service
public class StripeService {

    private final AppProperties props;
    private final UserRepository userRepository;

    public StripeService(AppProperties props, UserRepository userRepository) {
        this.props = props;
        this.userRepository = userRepository;
    }

    @PostConstruct
    void init() {
        Stripe.apiKey = props.getStripe().getSecretKey();
    }

    public String createCheckoutSession(User user, Plan targetPlan, String successUrl, String cancelUrl)
            throws Exception {
        String priceId = switch (targetPlan) {
            case SOLO   -> props.getStripe().getPriceIdSolo();
            case PRO    -> props.getStripe().getPriceIdPro();
            case AGENCY -> props.getStripe().getPriceIdAgency();
            default     -> throw new IllegalArgumentException("No Stripe price for " + targetPlan);
        };

        String customerId = ensureCustomer(user);

        var params = SessionCreateParams.builder()
                .setMode(SessionCreateParams.Mode.SUBSCRIPTION)
                .setCustomer(customerId)
                .addLineItem(SessionCreateParams.LineItem.builder()
                        .setPrice(priceId).setQuantity(1L).build())
                .setSuccessUrl(successUrl)
                .setCancelUrl(cancelUrl)
                .putMetadata("userId", user.getId().toString())
                .build();

        return Session.create(params).getUrl();
    }

    public String createPaymentLink(com.invoiceflow.invoice.Invoice invoice) throws Exception {
        long amountCents = invoice.total()
                .multiply(java.math.BigDecimal.valueOf(100))
                .longValue();
        String currency = invoice.getCurrency().toLowerCase();

        var priceParams = com.stripe.param.PriceCreateParams.builder()
                .setCurrency(currency)
                .setUnitAmount(amountCents)
                .setProductData(com.stripe.param.PriceCreateParams.ProductData.builder()
                        .setName("Invoice #" + invoice.getInvoiceNumber()
                                + " — " + invoice.getUser().getFullName())
                        .build())
                .build();
        var price = com.stripe.model.Price.create(priceParams);

        var linkParams = PaymentLinkCreateParams.builder()
                .addLineItem(PaymentLinkCreateParams.LineItem.builder()
                        .setPrice(price.getId()).setQuantity(1L).build())
                .putMetadata("invoiceId", invoice.getId().toString())
                .build();
        return PaymentLink.create(linkParams).getUrl();
    }

    private String ensureCustomer(User user) throws Exception {
        if (user.getStripeCustomerId() != null) return user.getStripeCustomerId();
        var params = CustomerCreateParams.builder()
                .setEmail(user.getEmail())
                .setName(user.getFullName())
                .build();
        String id = Customer.create(params).getId();
        user.setStripeCustomerId(id);
        userRepository.save(user);
        return id;
    }
}
