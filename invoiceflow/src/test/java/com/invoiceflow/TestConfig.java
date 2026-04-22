package com.invoiceflow;

import com.invoiceflow.email.EmailService;
import com.invoiceflow.pdf.PdfService;
import com.invoiceflow.stripe.StripeService;
import org.mockito.Mockito;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

@TestConfiguration
public class TestConfig {

    @Bean @Primary
    public EmailService emailService() {
        return Mockito.mock(EmailService.class);
    }

    @Bean @Primary
    public StripeService stripeService(com.invoiceflow.config.AppProperties props,
                                        com.invoiceflow.user.UserRepository repo) {
        return Mockito.mock(StripeService.class);
    }

    @Bean @Primary
    public PdfService pdfService() {
        var mock = Mockito.mock(PdfService.class);
        Mockito.when(mock.generate(Mockito.any())).thenReturn(new byte[0]);
        return mock;
    }
}
