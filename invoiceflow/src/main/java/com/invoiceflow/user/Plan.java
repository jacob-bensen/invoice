package com.invoiceflow.user;

public enum Plan {
    FREE(5, 1, false),
    SOLO(Integer.MAX_VALUE, 10, false),
    PRO(Integer.MAX_VALUE, Integer.MAX_VALUE, true),
    AGENCY(Integer.MAX_VALUE, Integer.MAX_VALUE, true);

    public final int maxInvoicesPerMonth;
    public final int maxClients;
    public final boolean autoReminders;

    Plan(int maxInvoicesPerMonth, int maxClients, boolean autoReminders) {
        this.maxInvoicesPerMonth = maxInvoicesPerMonth;
        this.maxClients = maxClients;
        this.autoReminders = autoReminders;
    }
}
