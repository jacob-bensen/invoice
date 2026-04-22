package com.invoiceflow;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.invoiceflow.auth.AuthController;
import com.invoiceflow.branding.BrandingController;
import com.invoiceflow.user.Plan;
import com.invoiceflow.user.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@DirtiesContext(classMode = DirtiesContext.ClassMode.BEFORE_EACH_TEST_METHOD)
@org.springframework.context.annotation.Import(TestConfig.class)
class BrandingControllerTest {

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired UserRepository userRepository;

    private String token;

    @BeforeEach
    void setUp() throws Exception {
        var req = new AuthController.RegisterRequest("brand@example.com", "password123", "Brand User");
        var result = mvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andReturn();
        token = mapper.readTree(result.getResponse().getContentAsString()).get("token").asText();
    }

    @Test
    void getDefaultBranding_returnsDefaults() throws Exception {
        mvc.perform(get("/api/branding")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.brandColor").value("#2563eb"))
                .andExpect(jsonPath("$.hasLogo").value(false));
    }

    @Test
    void updateBranding_asFreePlan_returns402() throws Exception {
        var req = new BrandingController.BrandingSettingsRequest(
                "#ff5733", "Acme Corp", null, null, null);
        mvc.perform(put("/api/branding")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void updateBranding_asProPlan_succeeds() throws Exception {
        upgradeToPro();
        var req = new BrandingController.BrandingSettingsRequest(
                "#ff5733", "Acme Corp", "123 Main St", "+1-555-0100", "acme.com");
        mvc.perform(put("/api/branding")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.brandColor").value("#ff5733"))
                .andExpect(jsonPath("$.companyName").value("Acme Corp"))
                .andExpect(jsonPath("$.companyAddress").value("123 Main St"))
                .andExpect(jsonPath("$.companyPhone").value("+1-555-0100"))
                .andExpect(jsonPath("$.companyWebsite").value("acme.com"));
    }

    @Test
    void updateBranding_invalidColor_returns400() throws Exception {
        upgradeToPro();
        var req = new BrandingController.BrandingSettingsRequest(
                "notacolor", "Acme", null, null, null);
        mvc.perform(put("/api/branding")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isBadRequest());
    }

    @Test
    void uploadLogo_asFreePlan_returns402() throws Exception {
        var file = new MockMultipartFile("file", "logo.png", "image/png", new byte[]{1, 2, 3});
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void uploadLogo_asProPlan_succeeds_andCanBeRetrieved() throws Exception {
        upgradeToPro();
        byte[] pngBytes = minimalPngBytes();
        var file = new MockMultipartFile("file", "logo.png", "image/png", pngBytes);

        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.message").value("Logo uploaded"));

        mvc.perform(get("/api/branding")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasLogo").value(true));

        mvc.perform(get("/api/branding/logo")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.IMAGE_PNG));
    }

    @Test
    void uploadLogo_oversized_returns400() throws Exception {
        upgradeToPro();
        byte[] bigFile = new byte[3 * 1024 * 1024]; // 3MB
        var file = new MockMultipartFile("file", "big.png", "image/png", bigFile);
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("Logo must be 2 MB or smaller"));
    }

    @Test
    void uploadLogo_invalidContentType_returns400() throws Exception {
        upgradeToPro();
        var file = new MockMultipartFile("file", "doc.pdf", "application/pdf", new byte[]{1, 2, 3});
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("Only PNG and JPEG logos are accepted"));
    }

    @Test
    void deleteLogo_asProPlan_succeeds() throws Exception {
        upgradeToPro();
        var file = new MockMultipartFile("file", "logo.png", "image/png", minimalPngBytes());
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk());

        mvc.perform(delete("/api/branding/logo")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isNoContent());

        mvc.perform(get("/api/branding/logo")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isNotFound());
    }

    private void upgradeToPro() {
        var user = userRepository.findByEmail("brand@example.com").orElseThrow();
        user.setPlan(Plan.PRO);
        userRepository.save(user);
    }

    /** Minimal valid 1x1 white PNG bytes. */
    private byte[] minimalPngBytes() {
        return new byte[]{
            (byte)0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  // PNG signature
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,          // IHDR chunk
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, (byte)0x90, 0x77, 0x53,
            (byte)0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,    // IDAT chunk
            0x54, 0x08, (byte)0xD7, 0x63, (byte)0xF8, (byte)0xCF,
            (byte)0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
            (byte)0xE2, 0x21, (byte)0xBC, 0x33, 0x00, 0x00, 0x00,    // IEND chunk
            0x00, 0x49, 0x45, 0x4E, 0x44, (byte)0xAE, 0x42, 0x60,
            (byte)0x82
        };
    }
}
