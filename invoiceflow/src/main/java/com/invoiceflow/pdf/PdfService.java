package com.invoiceflow.pdf;

import com.invoiceflow.invoice.Invoice;
import com.invoiceflow.invoice.LineItem;
import com.invoiceflow.user.Plan;
import com.invoiceflow.user.User;
import com.itextpdf.io.image.ImageDataFactory;
import com.itextpdf.kernel.colors.ColorConstants;
import com.itextpdf.kernel.colors.DeviceRgb;
import com.itextpdf.kernel.font.PdfFontFactory;
import com.itextpdf.kernel.pdf.PdfDocument;
import com.itextpdf.kernel.pdf.PdfWriter;
import com.itextpdf.layout.Document;
import com.itextpdf.layout.borders.Border;
import com.itextpdf.layout.borders.SolidBorder;
import com.itextpdf.layout.element.*;
import com.itextpdf.layout.properties.TextAlignment;
import com.itextpdf.layout.properties.UnitValue;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.math.BigDecimal;
import java.text.NumberFormat;
import java.util.Base64;
import java.util.Currency;
import java.util.Locale;

@Service
public class PdfService {

    private static final DeviceRgb DEFAULT_BRAND_COLOR = new DeviceRgb(37, 99, 235); // blue-600

    public byte[] generate(Invoice invoice) {
        User user = invoice.getUser();
        DeviceRgb brandColor = parseBrandColor(user.getBrandColor());
        boolean hasBranding = user.getPlan() == Plan.PRO || user.getPlan() == Plan.AGENCY;

        try (var baos = new ByteArrayOutputStream()) {
            var writer = new PdfWriter(baos);
            var pdf   = new PdfDocument(writer);
            var doc   = new Document(pdf);

            User user = invoice.getUser();
            DeviceRgb brandColor = parseBrandColor(
                    user.getPlan().customBranding ? user.getBrandColor() : null);

            var boldFont    = PdfFontFactory.createFont(
                    com.itextpdf.io.font.constants.StandardFonts.HELVETICA_BOLD);
            var regularFont = PdfFontFactory.createFont(
                    com.itextpdf.io.font.constants.StandardFonts.HELVETICA);

            // Logo (Pro/Agency only)
            if (hasBranding && user.getLogoData() != null) {
                try {
                    byte[] logoBytes = Base64.getDecoder().decode(user.getLogoData());
                    var imgData = ImageDataFactory.create(logoBytes);
                    var logo = new Image(imgData);
                    logo.setMaxHeight(50);
                    logo.setAutoScaleWidth(true);
                    doc.add(logo);
                } catch (Exception ignored) {
                    // Corrupted logo data should not break PDF generation
                }
            }

            // Header
            doc.add(new Paragraph("INVOICE")
                    .setFont(boldFont).setFontSize(28).setFontColor(brandColor));
            doc.add(new Paragraph(hasBranding ? user.getFullName() : "InvoiceFlow")
                    .setFont(regularFont).setFontSize(10).setFontColor(ColorConstants.GRAY));
            doc.add(new Paragraph(" "));

            // Meta table
            var meta = new Table(UnitValue.createPercentArray(new float[]{1, 1}))
                    .setWidth(UnitValue.createPercentValue(100));
            meta.addCell(labeledCell("Invoice #", invoice.getInvoiceNumber(), boldFont, regularFont));
            meta.addCell(labeledCell("From", invoice.getUser().getFullName(), boldFont, regularFont));
            meta.addCell(labeledCell("Issue Date", invoice.getIssueDate().toString(), boldFont, regularFont));
            meta.addCell(labeledCell("Bill To",
                    invoice.getClient().getName()
                            + (invoice.getClient().getCompany() != null
                                    ? "\n" + invoice.getClient().getCompany() : "")
                            + "\n" + invoice.getClient().getEmail(),
                    boldFont, regularFont));
            meta.addCell(labeledCell("Due Date", invoice.getDueDate().toString(), boldFont, regularFont));
            meta.addCell(new Cell().setBorder(Border.NO_BORDER).add(new Paragraph("")));
            doc.add(meta);
            doc.add(new Paragraph(" "));

            // Line items table
            var table = new Table(UnitValue.createPercentArray(new float[]{5, 1.5f, 2, 2}))
                    .setWidth(UnitValue.createPercentValue(100));
            for (String header : new String[]{"Description", "Qty", "Unit Price", "Total"}) {
                table.addHeaderCell(new Cell()
                        .setBackgroundColor(brandColor)
                        .add(new Paragraph(header).setFont(boldFont).setFontSize(10)
                                .setFontColor(ColorConstants.WHITE)));
            }

            NumberFormat fmt = NumberFormat.getCurrencyInstance(Locale.US);
            try {
                fmt.setCurrency(Currency.getInstance(invoice.getCurrency()));
            } catch (IllegalArgumentException ignored) {}

            for (LineItem li : invoice.getLineItems()) {
                table.addCell(cell(li.getDescription(), regularFont));
                table.addCell(cell(li.getQuantity().toPlainString(), regularFont)
                        .setTextAlignment(TextAlignment.RIGHT));
                table.addCell(cell(fmt.format(li.getUnitPrice()), regularFont)
                        .setTextAlignment(TextAlignment.RIGHT));
                table.addCell(cell(fmt.format(li.total()), regularFont)
                        .setTextAlignment(TextAlignment.RIGHT));
            }

            // Total row
            table.addCell(new Cell(1, 3)
                    .add(new Paragraph("TOTAL").setFont(boldFont).setFontSize(11))
                    .setTextAlignment(TextAlignment.RIGHT)
                    .setBorderTop(new com.itextpdf.layout.borders.SolidBorder(brandColor, 1.5f)));
            table.addCell(new Cell()
                    .add(new Paragraph(fmt.format(invoice.total())).setFont(boldFont).setFontSize(11)
                            .setFontColor(brandColor))
                    .setTextAlignment(TextAlignment.RIGHT)
                    .setBorderTop(new com.itextpdf.layout.borders.SolidBorder(brandColor, 1.5f)));

            doc.add(table);

            if (invoice.getNotes() != null && !invoice.getNotes().isBlank()) {
                doc.add(new Paragraph(" "));
                doc.add(new Paragraph("Notes").setFont(boldFont).setFontSize(10));
                doc.add(new Paragraph(invoice.getNotes()).setFont(regularFont).setFontSize(9));
            }

            if (invoice.getStripePaymentLink() != null) {
                doc.add(new Paragraph(" "));
                doc.add(new Paragraph("Pay Online: " + invoice.getStripePaymentLink())
                        .setFont(regularFont).setFontSize(9).setFontColor(brandColor));
            }

            doc.close();
            return baos.toByteArray();
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate PDF", e);
        }
    }

    private DeviceRgb parseBrandColor(String hex) {
        if (hex == null || !hex.matches("^#[0-9a-fA-F]{6}$")) {
            return DEFAULT_BRAND_COLOR;
        }
        int r = Integer.parseInt(hex.substring(1, 3), 16);
        int g = Integer.parseInt(hex.substring(3, 5), 16);
        int b = Integer.parseInt(hex.substring(5, 7), 16);
        return new DeviceRgb(r, g, b);
    }

    private Cell labeledCell(String label, String value,
                              com.itextpdf.kernel.font.PdfFont bold,
                              com.itextpdf.kernel.font.PdfFont regular) {
        return new Cell().setBorder(Border.NO_BORDER)
                .add(new Paragraph(label).setFont(bold).setFontSize(9).setFontColor(ColorConstants.GRAY))
                .add(new Paragraph(value).setFont(regular).setFontSize(10));
    }

    private Cell cell(String text, com.itextpdf.kernel.font.PdfFont font) {
        return new Cell().add(new Paragraph(text).setFont(font).setFontSize(10));
    }
}
