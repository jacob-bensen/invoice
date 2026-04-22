package com.invoiceflow.email;

import com.invoiceflow.config.AppProperties;
import com.invoiceflow.invoice.Invoice;
import jakarta.mail.MessagingException;
import jakarta.mail.internet.MimeMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.text.NumberFormat;
import java.util.Currency;
import java.util.Locale;

@Service
public class EmailService {

    private static final Logger log = LoggerFactory.getLogger(EmailService.class);

    private final JavaMailSender mailSender;
    private final AppProperties props;

    public EmailService(JavaMailSender mailSender, AppProperties props) {
        this.mailSender = mailSender;
        this.props = props;
    }

    @Async
    public void sendInvoice(Invoice invoice, byte[] pdfBytes) {
        try {
            MimeMessage msg = mailSender.createMimeMessage();
            var helper = new MimeMessageHelper(msg, true, "UTF-8");
            helper.setFrom(props.getFromEmail());
            helper.setTo(invoice.getClient().getEmail());
            helper.setSubject("Invoice #" + invoice.getInvoiceNumber()
                    + " from " + invoice.getUser().getFullName());
            helper.setText(buildInvoiceHtml(invoice), true);
            helper.addAttachment("invoice-" + invoice.getInvoiceNumber() + ".pdf",
                    () -> new java.io.ByteArrayInputStream(pdfBytes),
                    "application/pdf");
            mailSender.send(msg);
            log.info("Invoice {} sent to {}", invoice.getInvoiceNumber(), invoice.getClient().getEmail());
        } catch (MessagingException e) {
            log.error("Failed to send invoice email for {}", invoice.getInvoiceNumber(), e);
        }
    }

    @Async
    public void sendReminder(Invoice invoice) {
        try {
            MimeMessage msg = mailSender.createMimeMessage();
            var helper = new MimeMessageHelper(msg, false, "UTF-8");
            helper.setFrom(props.getFromEmail());
            helper.setTo(invoice.getClient().getEmail());
            helper.setSubject("Payment reminder: Invoice #" + invoice.getInvoiceNumber()
                    + " is overdue");
            helper.setText(buildReminderHtml(invoice), true);
            mailSender.send(msg);
            log.info("Reminder sent for invoice {} to {}", invoice.getInvoiceNumber(),
                    invoice.getClient().getEmail());
        } catch (MessagingException e) {
            log.error("Failed to send reminder for invoice {}", invoice.getInvoiceNumber(), e);
        }
    }

    private String buildInvoiceHtml(Invoice invoice) {
        NumberFormat fmt = currencyFormat(invoice.getCurrency());
        String payLink = invoice.getStripePaymentLink() != null
                ? "<p><a href=\"" + invoice.getStripePaymentLink() + "\" style=\"background:#2563eb;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;\">Pay Now</a></p>"
                : "";
        return """
            <html><body style="font-family:sans-serif;color:#1f2937;">
            <h2 style="color:#2563eb;">Invoice #%s</h2>
            <p>Hi %s,</p>
            <p>Please find your invoice of <strong>%s</strong> attached, due on <strong>%s</strong>.</p>
            %s
            <p>Thank you,<br>%s</p>
            </body></html>
            """.formatted(
                invoice.getInvoiceNumber(),
                invoice.getClient().getName(),
                fmt.format(invoice.total()),
                invoice.getDueDate(),
                payLink,
                invoice.getUser().getFullName());
    }

    private String buildReminderHtml(Invoice invoice) {
        NumberFormat fmt = currencyFormat(invoice.getCurrency());
        String payLink = invoice.getStripePaymentLink() != null
                ? "<p><a href=\"" + invoice.getStripePaymentLink() + "\" style=\"background:#dc2626;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;\">Pay Now</a></p>"
                : "";
        return """
            <html><body style="font-family:sans-serif;color:#1f2937;">
            <h2 style="color:#dc2626;">Payment Overdue</h2>
            <p>Hi %s,</p>
            <p>Invoice <strong>#%s</strong> for <strong>%s</strong> was due on <strong>%s</strong> and remains unpaid.</p>
            %s
            <p>Please arrange payment at your earliest convenience.</p>
            <p>%s</p>
            </body></html>
            """.formatted(
                invoice.getClient().getName(),
                invoice.getInvoiceNumber(),
                fmt.format(invoice.total()),
                invoice.getDueDate(),
                payLink,
                invoice.getUser().getFullName());
    }

    private NumberFormat currencyFormat(String currency) {
        var fmt = NumberFormat.getCurrencyInstance(Locale.US);
        try { fmt.setCurrency(Currency.getInstance(currency)); } catch (Exception ignored) {}
        return fmt;
    }
}
