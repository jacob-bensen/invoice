package com.invoiceflow.user;

import jakarta.persistence.*;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "users")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String email;

    @Column(name = "password_hash", nullable = false)
    private String passwordHash;

    @Column(name = "full_name", nullable = false)
    private String fullName;

    @Enumerated(EnumType.STRING)
    @Column(length = 20)
    private Plan plan = Plan.FREE;

    @Column(name = "stripe_customer_id")
    private String stripeCustomerId;

    @Column(name = "stripe_sub_id")
    private String stripeSubId;

    @Enumerated(EnumType.STRING)
    @Column(name = "sub_status", length = 20)
    private SubscriptionStatus subStatus;

    @Column(name = "logo_data", columnDefinition = "TEXT")
    private String logoData;

    @Column(name = "brand_color", length = 7)
    private String brandColor;

    @Column(name = "created_at", updatable = false)
    private Instant createdAt = Instant.now();

    @UpdateTimestamp
    @Column(name = "updated_at")
    private Instant updatedAt;

    public Long getId() { return id; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getPasswordHash() { return passwordHash; }
    public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }
    public String getFullName() { return fullName; }
    public void setFullName(String fullName) { this.fullName = fullName; }
    public Plan getPlan() { return plan; }
    public void setPlan(Plan plan) { this.plan = plan; }
    public String getStripeCustomerId() { return stripeCustomerId; }
    public void setStripeCustomerId(String stripeCustomerId) { this.stripeCustomerId = stripeCustomerId; }
    public String getStripeSubId() { return stripeSubId; }
    public void setStripeSubId(String stripeSubId) { this.stripeSubId = stripeSubId; }
    public SubscriptionStatus getSubStatus() { return subStatus; }
    public void setSubStatus(SubscriptionStatus subStatus) { this.subStatus = subStatus; }
    public String getLogoData() { return logoData; }
    public void setLogoData(String logoData) { this.logoData = logoData; }
    public String getBrandColor() { return brandColor; }
    public void setBrandColor(String brandColor) { this.brandColor = brandColor; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
