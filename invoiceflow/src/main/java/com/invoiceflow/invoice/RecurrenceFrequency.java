package com.invoiceflow.invoice;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;

public enum RecurrenceFrequency {
    WEEKLY(7, ChronoUnit.DAYS),
    BIWEEKLY(14, ChronoUnit.DAYS),
    MONTHLY(1, ChronoUnit.MONTHS),
    QUARTERLY(3, ChronoUnit.MONTHS);

    private final long amount;
    private final ChronoUnit unit;

    RecurrenceFrequency(long amount, ChronoUnit unit) {
        this.amount = amount;
        this.unit = unit;
    }

    public LocalDate advance(LocalDate from) {
        return from.plus(amount, unit);
    }

    public java.time.Instant advance(java.time.Instant from) {
        // Convert to UTC date-time, advance via calendar-aware unit, convert back.
        var dateTime = from.atZone(ZoneOffset.UTC).toLocalDateTime().plus(amount, unit);
        return dateTime.toInstant(ZoneOffset.UTC);
    }
}
