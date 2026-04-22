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
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@org.springframework.context.annotation.Import(TestConfig.class)
class BrandingControllerTest {

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired UserRepository userRepository;

    private String freeToken;
    private String proToken;

    @BeforeEach
    void setUp() throws Exception {
        userRepository.findByEmail("branding-free@example.com").ifPresent(userRepository::delete);
        userRepository.findByEmail("branding-pro@example.com").ifPresent(userRepository::delete);

        freeToken = register("branding-free@example.com", "password123", "Free User");
        proToken  = register("branding-pro@example.com",  "password123", "Pro User");

        // upgrade pro user in DB
        var proUser = userRepository.findByEmail("branding-pro@example.com").orElseThrow();
        proUser.setPlan(Plan.PRO);
        userRepository.save(proUser);
    }

    @Test
    void getDefaultBranding() throws Exception {
        mvc.perform(get("/api/branding")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.brandColor").value("#2563EB"))
                .andExpect(jsonPath("$.hasLogo").value(false));
    }

    @Test
    void updateColorProPlan() throws Exception {
        var req = new BrandingController.ColorRequest("#FF5733");
        mvc.perform(put("/api/branding/color")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.brandColor").value("#FF5733"));
    }

    @Test
    void updateColorFreePlanForbidden() throws Exception {
        var req = new BrandingController.ColorRequest("#FF5733");
        mvc.perform(put("/api/branding/color")
                        .header("Authorization", "Bearer " + freeToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void updateColorInvalidHexRejected() throws Exception {
        var req = new BrandingController.ColorRequest("not-a-color");
        mvc.perform(put("/api/branding/color")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isBadRequest());
    }

    @Test
    void uploadAndRetrieveAndDeleteLogo() throws Exception {
        byte[] pngBytes = minimalPng();
        var file = new MockMultipartFile("file", "logo.png", "image/png", pngBytes);

        // upload
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasLogo").value(true));

        // retrieve
        var result = mvc.perform(get("/api/branding/logo")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.IMAGE_PNG))
                .andReturn();
        assertThat(result.getResponse().getContentAsByteArray()).isEqualTo(pngBytes);

        // delete
        mvc.perform(delete("/api/branding/logo")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasLogo").value(false));

        // 404 after delete
        mvc.perform(get("/api/branding/logo")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isNotFound());
    }

    @Test
    void uploadLogoFreePlanForbidden() throws Exception {
        var file = new MockMultipartFile("file", "logo.png", "image/png", minimalPng());
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + freeToken))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void uploadLogoUnsupportedTypeForbidden() throws Exception {
        var file = new MockMultipartFile("file", "doc.pdf", "application/pdf", new byte[]{1, 2, 3});
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isBadRequest());
    }

    // ---- helpers ----

    private String register(String email, String password, String name) throws Exception {
        var req = new AuthController.RegisterRequest(email, password, name);
        var body = mvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return mapper.readTree(body).get("token").asText();
    }

    /** Minimal valid 1×1 PNG (67 bytes). */
    private byte[] minimalPng() {
        return new byte[]{
            (byte)0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,         // IHDR chunk length + type
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,         // 1x1
            0x08, 0x02, 0x00, 0x00, 0x00, (byte)0x90, 0x77, 0x53,   // bit depth, color type, etc.
            (byte)0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,   // IDAT chunk
            0x54, 0x08, (byte)0xD7, 0x63, (byte)0xF8, (byte)0xCF,
            (byte)0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
            (byte)0xE2, 0x21, (byte)0xBC, 0x33, 0x00, 0x00, 0x00,   // IEND chunk
            0x00, 0x49, 0x45, 0x4E, 0x44, (byte)0xAE, 0x42, 0x60,
            (byte)0x82
        };
    }
}
