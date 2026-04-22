package com.invoiceflow.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "app")
public class AppProperties {

    private Jwt jwt = new Jwt();
    private Stripe stripe = new Stripe();
    private String fromEmail;
    private String baseUrl;
    private String uploadsDir = "./uploads";

    public static class Jwt {
        private String secret;
        private long expirationMs;

        public String getSecret() { return secret; }
        public void setSecret(String secret) { this.secret = secret; }
        public long getExpirationMs() { return expirationMs; }
        public void setExpirationMs(long expirationMs) { this.expirationMs = expirationMs; }
    }

    public static class Stripe {
        private String secretKey;
        private String webhookSecret;
        private String priceIdSolo;
        private String priceIdPro;
        private String priceIdAgency;

        public String getSecretKey() { return secretKey; }
        public void setSecretKey(String secretKey) { this.secretKey = secretKey; }
        public String getWebhookSecret() { return webhookSecret; }
        public void setWebhookSecret(String webhookSecret) { this.webhookSecret = webhookSecret; }
        public String getPriceIdSolo() { return priceIdSolo; }
        public void setPriceIdSolo(String priceIdSolo) { this.priceIdSolo = priceIdSolo; }
        public String getPriceIdPro() { return priceIdPro; }
        public void setPriceIdPro(String priceIdPro) { this.priceIdPro = priceIdPro; }
        public String getPriceIdAgency() { return priceIdAgency; }
        public void setPriceIdAgency(String priceIdAgency) { this.priceIdAgency = priceIdAgency; }
    }

    public Jwt getJwt() { return jwt; }
    public void setJwt(Jwt jwt) { this.jwt = jwt; }
    public Stripe getStripe() { return stripe; }
    public void setStripe(Stripe stripe) { this.stripe = stripe; }
    public String getFromEmail() { return fromEmail; }
    public void setFromEmail(String fromEmail) { this.fromEmail = fromEmail; }
    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }
    public String getUploadsDir() { return uploadsDir; }
    public void setUploadsDir(String uploadsDir) { this.uploadsDir = uploadsDir; }
}
