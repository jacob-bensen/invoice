package com.invoiceflow.invoice;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

public interface InvoiceRepository extends JpaRepository<Invoice, Long> {

    List<Invoice> findAllByUserIdOrderByCreatedAtDesc(Long userId);

    Optional<Invoice> findByIdAndUserId(Long id, Long userId);

    @Query("SELECT COUNT(i) FROM Invoice i WHERE i.user.id = :userId AND i.createdAt >= :start AND i.createdAt < :end")
    long countInPeriod(@Param("userId") Long userId,
                       @Param("start") Instant start,
                       @Param("end") Instant end);

    @Query("SELECT i FROM Invoice i JOIN FETCH i.client JOIN FETCH i.user WHERE i.status IN :statuses AND i.dueDate < :today")
    List<Invoice> findOverdue(@Param("statuses") List<InvoiceStatus> statuses,
                              @Param("today") LocalDate today);

    @Query("SELECT i FROM Invoice i JOIN FETCH i.client JOIN FETCH i.user WHERE i.status IN :statuses AND i.user.plan IN :plans")
    List<Invoice> findSentForAutoReminder(@Param("statuses") List<InvoiceStatus> statuses,
                                          @Param("plans") List<com.invoiceflow.user.Plan> plans);

    boolean existsByUserIdAndInvoiceNumber(Long userId, String invoiceNumber);

    @Query("SELECT i FROM Invoice i JOIN FETCH i.client JOIN FETCH i.user LEFT JOIN FETCH i.lineItems " +
           "WHERE i.recurrenceActive = TRUE AND i.recurrenceNextRun <= :asOf")
    List<Invoice> findDueForRecurrence(@Param("asOf") Instant asOf);

    @Query("SELECT i FROM Invoice i JOIN FETCH i.client WHERE i.user.id = :userId AND i.recurrenceActive = TRUE " +
           "ORDER BY i.recurrenceNextRun ASC")
    List<Invoice> findActiveRecurringByUser(@Param("userId") Long userId);
}
