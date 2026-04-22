package com.invoiceflow.pdf;

import com.invoiceflow.branding.UserLogoRepository;
import com.invoiceflow.invoice.Invoice;
import com.invoiceflow.invoice.LineItem;
import com.invoiceflow.user.User;
import com.itextpdf.io.image.ImageDataFactory;
import com.itextpdf.kernel.colors.ColorConstants;
import com.itextpdf.kernel.colors.DeviceRgb;
import com.itextpdf.kernel.font.PdfFont;
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
import java.text.NumberFormat;
import java.util.Currency;
import java.util.Locale;

@Service
public class PdfService {

    private static final DeviceRgb DEFAULT_BRAND_COLOR = new DeviceRgb(37, 99, 235);
    private static final String FOOTER_TEXT = "Created with InvoiceFlow · invoiceflow.app";

    private final UserLogoRepository userLogoRepository;

    public PdfService(UserLogoRepository userLogoRepository) {
        this.userLogoRepository = userLogoRepository;
    }

    public byte[] generate(Invoice invoice) {
        try (var baos = new ByteArrayOutputStream()) {
            var writer = new PdfWriter(baos);
            var pdf = new PdfDocument(writer);
            var doc = new Document(pdf);

            User user = invoice.getUser();
            DeviceRgb brandColor = resolveBrandColor(user);

            var boldFont = PdfFontFactory.createFont(
                    com.itextpdf.io.font.constants.StandardFonts.HELVETICA_BOLD);
            var regularFont = PdfFontFactory.createFont(
                    com.itextpdf.io.font.constants.StandardFonts.HELVETICA);

            // Logo (Pro/Agency with custom branding only)
            if (user.getPlan().customBranding) {
                userLogoRepository.findById(user.getId()).ifPresent(logo -> {
                    try {
                        var imgData = ImageDataFactory.create(logo.getLogoData());
                        var img = new Image(imgData);
                        img.setMaxWidth(UnitValue.createPointValue(150));
                        img.setMaxHeight(UnitValue.createPointValue(60));
                        doc.add(img);
                    } catch (Exception ignored) {}
                });
            }

            // Header
            doc.add(new Paragraph("INVOICE")
                    .setFont(boldFont).setFontSize(28).setFontColor(brandColor));

            String senderName = (user.getPlan().customBranding && user.getCompanyName() != null)
                    ? user.getCompanyName() : user.getFullName();
            doc.add(new Paragraph(senderName)
                    .setFont(regularFont).setFontSize(10).setFontColor(ColorConstants.GRAY));

            if (user.getPlan().customBranding) {
                addGrayLine(doc, user.getCompanyAddress(), regularFont);
                addGrayLine(doc, user.getCompanyPhone(), regularFont);
                addGrayLine(doc, user.getCompanyWebsite(), regularFont);
            }
            doc.add(new Paragraph(" "));

            // Meta table
            var meta = new Table(UnitValue.createPercentArray(new float[]{1, 1}))
                    .setWidth(UnitValue.createPercentValue(100));
            meta.addCell(labeledCell("Invoice #", invoice.getInvoiceNumber(), boldFont, regularFont));
            meta.addCell(labeledCell("From", invoice.getUser().getFullName(), boldFont, regularFont));
            meta.addCell(labeledCell("Issue Date", invoice.getIssueDate().toString(), boldFont, regularFont));
            meta.addCell(labeledCell("Bill To", invoice.getClient().getName()
                    + (invoice.getClient().getCompany() != null ? "\n" + invoice.getClient().getCompany() : "")
                    + "\n" + invoice.getClient().getEmail(), boldFont, regularFont));
            meta.addCell(labeledCell("Due Date", invoice.getDueDate().toString(), boldFont, regularFont));
            meta.addCell(new Cell().add(new Paragraph("")));
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
                    .setBorderTop(new SolidBorder(brandColor, 1.5f)));
            table.addCell(new Cell()
                    .add(new Paragraph(fmt.format(invoice.total())).setFont(boldFont).setFontSize(11)
                            .setFontColor(brandColor))
                    .setTextAlignment(TextAlignment.RIGHT)
                    .setBorderTop(new SolidBorder(brandColor, 1.5f)));

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

            // Branded footer on free/solo plans — passive acquisition touchpoint
            if (!user.getPlan().customBranding) {
                doc.add(new Paragraph(" "));
                doc.add(new Paragraph(FOOTER_TEXT)
                        .setFont(regularFont).setFontSize(8)
                        .setFontColor(ColorConstants.LIGHT_GRAY)
                        .setTextAlignment(TextAlignment.CENTER));
            }

            doc.close();
            return baos.toByteArray();
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate PDF", e);
        }
    }

    private DeviceRgb resolveBrandColor(User user) {
        if (user.getPlan().customBranding && user.getBrandColor() != null) {
            try {
                String hex = user.getBrandColor().replace("#", "");
                int r = Integer.parseInt(hex.substring(0, 2), 16);
                int g = Integer.parseInt(hex.substring(2, 4), 16);
                int b = Integer.parseInt(hex.substring(4, 6), 16);
                return new DeviceRgb(r, g, b);
            } catch (Exception ignored) {}
        }
        return DEFAULT_BRAND_COLOR;
    }

    private void addGrayLine(Document doc, String value, PdfFont font) {
        if (value != null && !value.isBlank()) {
            doc.add(new Paragraph(value).setFont(font).setFontSize(9).setFontColor(ColorConstants.GRAY));
        }
    }

    private Cell labeledCell(String label, String value, PdfFont bold, PdfFont regular) {
        return new Cell().setBorder(Border.NO_BORDER)
                .add(new Paragraph(label).setFont(bold).setFontSize(9).setFontColor(ColorConstants.GRAY))
                .add(new Paragraph(value).setFont(regular).setFontSize(10));
    }

    private Cell cell(String text, PdfFont font) {
        return new Cell().add(new Paragraph(text).setFont(font).setFontSize(10));
    }
}
