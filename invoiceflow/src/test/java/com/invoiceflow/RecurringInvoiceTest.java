package com.invoiceflow;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.invoiceflow.auth.AuthController;
import com.invoiceflow.client.ClientController;
import com.invoiceflow.invoice.Invoice;
import com.invoiceflow.invoice.InvoiceController;
import com.invoiceflow.invoice.InvoiceRepository;
import com.invoiceflow.invoice.InvoiceStatus;
import com.invoiceflow.invoice.RecurrenceFrequency;
import com.invoiceflow.scheduler.RecurringInvoiceJob;
import com.invoiceflow.user.Plan;
import com.invoiceflow.user.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * End-to-end tests for recurring-invoice auto-generation (INTERNAL_TODO #6 / P12).
 *
 * Covers:
 *  - PUT /api/invoices/{id}/recurrence plan-gating (Free → 402, Pro → 200, Agency → 200)
 *  - Invalid frequency rejected
 *  - active=false clears the recurrence flag without deleting data
 *  - GET /api/invoices/recurring lists the authenticated user's active recurrences only
 *  - Scheduler clones a due invoice as DRAFT with identical line items + advances next_run
 *  - Scheduler does NOT clone invoices whose next_run is in the future
 *  - Clones are DRAFT so the reminder scheduler's SENT/OVERDUE filter never touches them
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@DirtiesContext(classMode = DirtiesContext.ClassMode.BEFORE_EACH_TEST_METHOD)
@org.springframework.context.annotation.Import(TestConfig.class)
class RecurringInvoiceTest {

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired UserRepository userRepository;
    @Autowired InvoiceRepository invoiceRepository;
    @Autowired RecurringInvoiceJob recurringInvoiceJob;

    private String freeToken;
    private String proToken;
    private Long proClientId;

    @BeforeEach
    void setUp() throws Exception {
        freeToken = register("rec-free@example.com", "password123", "Free User");
        proToken  = register("rec-pro@example.com",  "password123", "Pro User");

        // Elevate pro user
        var proUser = userRepository.findByEmail("rec-pro@example.com").orElseThrow();
        proUser.setPlan(Plan.PRO);
        userRepository.save(proUser);

        // Pro user needs a client for invoices.
        proClientId = createClient(proToken, "Recurring Client", "client@example.com");
    }

    // ---- PUT /api/invoices/{id}/recurrence ----

    @Test
    void setRecurrence_freeUserRejectedWith402() throws Exception {
        // Free user must have a client + invoice first.
        Long freeClientId = createClient(freeToken, "Free Client", "free-client@example.com");
        Long invoiceId = createInvoice(freeToken, freeClientId, "FREE-REC-1");

        var req = Map.of("frequency", "MONTHLY", "active", true);
        mvc.perform(put("/api/invoices/" + invoiceId + "/recurrence")
                        .header("Authorization", "Bearer " + freeToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void setRecurrence_proUserSucceeds() throws Exception {
        Long invoiceId = createInvoice(proToken, proClientId, "PRO-REC-1");

        var req = Map.of("frequency", "MONTHLY", "active", true);
        mvc.perform(put("/api/invoices/" + invoiceId + "/recurrence")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.recurrenceActive").value(true))
                .andExpect(jsonPath("$.recurrenceFrequency").value("MONTHLY"))
                .andExpect(jsonPath("$.recurrenceNextRun").isNotEmpty());
    }

    @Test
    void setRecurrence_agencyUserSucceeds() throws Exception {
        var u = userRepository.findByEmail("rec-pro@example.com").orElseThrow();
        u.setPlan(Plan.AGENCY);
        userRepository.save(u);

        Long invoiceId = createInvoice(proToken, proClientId, "AGY-REC-1");
        var req = Map.of("frequency", "WEEKLY", "active", true);
        mvc.perform(put("/api/invoices/" + invoiceId + "/recurrence")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.recurrenceFrequency").value("WEEKLY"));
    }

    @Test
    void setRecurrence_invalidFrequencyRejected() throws Exception {
        Long invoiceId = createInvoice(proToken, proClientId, "PRO-REC-BAD");
        var req = Map.of("frequency", "DAILY", "active", true);
        mvc.perform(put("/api/invoices/" + invoiceId + "/recurrence")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isBadRequest());
    }

    @Test
    void setRecurrence_activeFalseClearsRecurrence() throws Exception {
        Long invoiceId = createInvoice(proToken, proClientId, "PRO-REC-CLEAR");

        // First enable
        mvc.perform(put("/api/invoices/" + invoiceId + "/recurrence")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("frequency", "MONTHLY", "active", true))))
                .andExpect(status().isOk());

        // Now disable
        mvc.perform(put("/api/invoices/" + invoiceId + "/recurrence")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("active", false))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.recurrenceActive").value(false));
    }

    // ---- GET /api/invoices/recurring ----

    @Test
    void listRecurring_onlyReturnsActiveForAuthenticatedUser() throws Exception {
        Long a = createInvoice(proToken, proClientId, "PRO-LIST-A");
        Long b = createInvoice(proToken, proClientId, "PRO-LIST-B");
        Long c = createInvoice(proToken, proClientId, "PRO-LIST-C"); // not recurring

        enableRecurrence(a, "WEEKLY");
        enableRecurrence(b, "MONTHLY");

        mvc.perform(get("/api/invoices/recurring")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[?(@.invoiceNumber=='PRO-LIST-A')].recurrenceFrequency").value("WEEKLY"))
                .andExpect(jsonPath("$[?(@.invoiceNumber=='PRO-LIST-B')].recurrenceFrequency").value("MONTHLY"));
    }

    // ---- Scheduler ----

    @Test
    @org.springframework.transaction.annotation.Transactional
    void scheduler_clonesDueInvoiceAsDraftAndAdvancesNextRun() {
        Long invoiceId = createInvoiceDirect("SCHED-DUE", BigDecimal.valueOf(250));
        Invoice template = invoiceRepository.findById(invoiceId).orElseThrow();
        template.setRecurrenceFrequency(RecurrenceFrequency.MONTHLY);
        template.setRecurrenceActive(true);
        Instant pastDue = Instant.now().minus(1, ChronoUnit.DAYS);
        template.setRecurrenceNextRun(pastDue);
        invoiceRepository.save(template);

        int created = recurringInvoiceJob.generateDueInvoices(Instant.now());
        assertThat(created).isEqualTo(1);

        Invoice reloaded = invoiceRepository.findById(invoiceId).orElseThrow();
        assertThat(reloaded.getRecurrenceNextRun()).isAfter(Instant.now());

        List<Invoice> all = invoiceRepository.findAll();
        Invoice clone = all.stream()
                .filter(i -> !i.getId().equals(invoiceId))
                .findFirst().orElseThrow();

        assertThat(clone.getStatus()).isEqualTo(InvoiceStatus.DRAFT);
        assertThat(clone.getRecurrenceSourceId()).isEqualTo(invoiceId);
        assertThat(clone.getLineItems()).hasSize(1);
        assertThat(clone.getLineItems().get(0).getDescription()).isEqualTo("Retainer");
        assertThat(clone.total()).isEqualByComparingTo(BigDecimal.valueOf(250));
        assertThat(clone.getIssueDate()).isEqualTo(LocalDate.now(ZoneOffset.UTC));
        // Safety for ReminderScheduler: clone is DRAFT, not SENT/OVERDUE — reminder job won't touch it.
    }

    @Test
    void scheduler_skipsInvoicesWithFutureNextRun() {
        Long invoiceId = createInvoiceDirect("SCHED-FUTURE", BigDecimal.valueOf(100));
        Invoice template = invoiceRepository.findById(invoiceId).orElseThrow();
        template.setRecurrenceFrequency(RecurrenceFrequency.MONTHLY);
        template.setRecurrenceActive(true);
        template.setRecurrenceNextRun(Instant.now().plus(7, ChronoUnit.DAYS));
        invoiceRepository.save(template);

        long countBefore = invoiceRepository.count();
        int created = recurringInvoiceJob.generateDueInvoices(Instant.now());
        long countAfter = invoiceRepository.count();

        assertThat(created).isEqualTo(0);
        assertThat(countAfter).isEqualTo(countBefore);
    }

    @Test
    void scheduler_repeatInvocationsDoNotDuplicateSameCycle() {
        Long invoiceId = createInvoiceDirect("SCHED-IDEMP", BigDecimal.valueOf(50));
        Invoice template = invoiceRepository.findById(invoiceId).orElseThrow();
        template.setRecurrenceFrequency(RecurrenceFrequency.WEEKLY);
        template.setRecurrenceActive(true);
        template.setRecurrenceNextRun(Instant.now().minus(1, ChronoUnit.DAYS));
        invoiceRepository.save(template);

        Instant now = Instant.now();
        recurringInvoiceJob.generateDueInvoices(now);
        // Second immediate invocation: next_run is now in the future, so nothing should clone.
        int secondRun = recurringInvoiceJob.generateDueInvoices(now);
        assertThat(secondRun).isEqualTo(0);
    }

    @Test
    void scheduler_weeklyAdvancesBySevenDays() {
        Long invoiceId = createInvoiceDirect("SCHED-WEEKLY", BigDecimal.valueOf(75));
        Invoice template = invoiceRepository.findById(invoiceId).orElseThrow();
        Instant baselineNextRun = LocalDate.of(2026, 1, 15).atStartOfDay().toInstant(ZoneOffset.UTC);
        template.setRecurrenceFrequency(RecurrenceFrequency.WEEKLY);
        template.setRecurrenceActive(true);
        template.setRecurrenceNextRun(baselineNextRun);
        invoiceRepository.save(template);

        Instant asOf = LocalDate.of(2026, 1, 20).atStartOfDay().toInstant(ZoneOffset.UTC);
        recurringInvoiceJob.generateDueInvoices(asOf);

        Invoice reloaded = invoiceRepository.findById(invoiceId).orElseThrow();
        // Starting from Jan 15 (past), one WEEKLY step lands on Jan 22 which is > Jan 20, so that's next_run.
        assertThat(reloaded.getRecurrenceNextRun())
                .isEqualTo(LocalDate.of(2026, 1, 22).atStartOfDay().toInstant(ZoneOffset.UTC));
    }

    // ---- helpers ----

    private String register(String email, String password, String name) throws Exception {
        var req = new AuthController.RegisterRequest(email, password, name);
        var result = mvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode node = mapper.readTree(result.getResponse().getContentAsString());
        return node.get("token").asText();
    }

    private Long createClient(String token, String name, String email) throws Exception {
        var req = new ClientController.ClientRequest(name, email, null, null);
        var result = mvc.perform(post("/api/clients")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andReturn();
        return mapper.readTree(result.getResponse().getContentAsString()).get("id").asLong();
    }

    private Long createInvoice(String token, Long clientId, String invoiceNumber) throws Exception {
        var li = new InvoiceController.LineItemRequest("Service", BigDecimal.valueOf(1),
                BigDecimal.valueOf(100), 0);
        var req = new InvoiceController.InvoiceRequest(
                clientId, invoiceNumber,
                LocalDate.now(), LocalDate.now().plusDays(30),
                "USD", "test", List.of(li));
        var result = mvc.perform(post("/api/invoices")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andReturn();
        return mapper.readTree(result.getResponse().getContentAsString()).get("id").asLong();
    }

    /** Direct DB creation — avoids hitting the monthly-invoice limit during scheduler tests. */
    private Long createInvoiceDirect(String invoiceNumber, BigDecimal unitPrice) {
        var user = userRepository.findByEmail("rec-pro@example.com").orElseThrow();
        var client = new com.invoiceflow.client.Client();
        client.setUser(user);
        client.setName("Direct Client");
        client.setEmail("direct-" + invoiceNumber + "@example.com");
        user.getClass(); // noop to keep imports tidy
        // Persist client via repository — fetched via autowired? We have invoiceRepository only.
        // Simpler: reuse proClientId.
        var clientEntity = invoiceRepository.findAll().stream()
                .filter(i -> i.getUser().getId().equals(user.getId()))
                .map(Invoice::getClient)
                .findFirst().orElse(null);
        Invoice inv = new Invoice();
        inv.setUser(user);
        inv.setClient(clientEntity != null ? clientEntity : fallbackClient(user));
        inv.setInvoiceNumber(invoiceNumber);
        inv.setIssueDate(LocalDate.now().minusDays(5));
        inv.setDueDate(LocalDate.now().plusDays(25));
        inv.setCurrency("USD");
        inv.setStatus(InvoiceStatus.SENT);
        var lineItem = new com.invoiceflow.invoice.LineItem();
        lineItem.setInvoice(inv);
        lineItem.setDescription("Retainer");
        lineItem.setQuantity(BigDecimal.ONE);
        lineItem.setUnitPrice(unitPrice);
        lineItem.setSortOrder(0);
        inv.getLineItems().add(lineItem);
        return invoiceRepository.save(inv).getId();
    }

    @Autowired com.invoiceflow.client.ClientRepository clientRepository;

    private com.invoiceflow.client.Client fallbackClient(com.invoiceflow.user.User user) {
        var c = clientRepository.findAllByUserIdOrderByNameAsc(user.getId());
        if (!c.isEmpty()) return c.get(0);
        var client = new com.invoiceflow.client.Client();
        client.setUser(user);
        client.setName("Fallback");
        client.setEmail("fallback@example.com");
        return clientRepository.save(client);
    }

    private void enableRecurrence(Long invoiceId, String frequency) throws Exception {
        mvc.perform(put("/api/invoices/" + invoiceId + "/recurrence")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("frequency", frequency, "active", true))))
                .andExpect(status().isOk());
    }
}
