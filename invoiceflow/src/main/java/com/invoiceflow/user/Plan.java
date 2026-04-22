package com.invoiceflow.user;

public enum Plan {
    FREE(5, 1, false, false),
    SOLO(Integer.MAX_VALUE, 10, false, false),
    PRO(Integer.MAX_VALUE, Integer.MAX_VALUE, true, true),
    AGENCY(Integer.MAX_VALUE, Integer.MAX_VALUE, true, true);

    public final int maxInvoicesPerMonth;
    public final int maxClients;
    public final boolean autoReminders;
    public final boolean customBranding;

    Plan(int maxInvoicesPerMonth, int maxClients, boolean autoReminders, boolean customBranding) {
        this.maxInvoicesPerMonth = maxInvoicesPerMonth;
        this.maxClients = maxClients;
        this.autoReminders = autoReminders;
        this.customBranding = customBranding;
    }
}
