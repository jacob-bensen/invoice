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
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;

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
        freeToken = registerAndGetToken("free@example.com", "free user");
        proToken   = registerAndGetToken("pro@example.com",  "pro user");

        // Elevate the pro user to PRO plan directly
        userRepository.findByEmail("pro@example.com").ifPresent(u -> {
            u.setPlan(Plan.PRO);
            userRepository.save(u);
        });
    }

    // ---- GET /api/branding ----

    @Test
    void getBranding_defaultsToNoBrandingForNewUser() throws Exception {
        mvc.perform(get("/api/branding")
                        .header("Authorization", "Bearer " + freeToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasLogo").value(false))
                .andExpect(jsonPath("$.brandColor").isEmpty());
    }

    // ---- PUT /api/branding/color ----

    @Test
    void updateColor_freeUserGets402() throws Exception {
        var req = new BrandingController.ColorRequest("#FF5733");
        mvc.perform(put("/api/branding/color")
                        .header("Authorization", "Bearer " + freeToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void updateColor_proUserSucceeds() throws Exception {
        var req = new BrandingController.ColorRequest("#FF5733");
        mvc.perform(put("/api/branding/color")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.brandColor").value("#FF5733"));
    }

    @Test
    void updateColor_invalidHexRejected() throws Exception {
        var req = Map.of("brandColor", "not-a-color");
        mvc.perform(put("/api/branding/color")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isBadRequest());
    }

    // ---- POST /api/branding/logo ----

    @Test
    void uploadLogo_freeUserGets402() throws Exception {
        var file = new MockMultipartFile("file", "logo.png", "image/png", new byte[]{1, 2, 3});
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + freeToken))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void uploadLogo_proUserSucceeds() throws Exception {
        var pngBytes = minimalPng();
        var file = new MockMultipartFile("file", "logo.png", "image/png", pngBytes);
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasLogo").value(true));

        // GET /api/branding now shows hasLogo = true
        mvc.perform(get("/api/branding")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(jsonPath("$.hasLogo").value(true));
    }

    @Test
    void uploadLogo_unsupportedMimeRejected() throws Exception {
        var file = new MockMultipartFile("file", "logo.pdf", "application/pdf", new byte[]{1});
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isBadRequest());
    }

    @Test
    void uploadLogo_tooLargeRejected() throws Exception {
        var bigFile = new MockMultipartFile("file", "big.png", "image/png", new byte[600 * 1024]);
        mvc.perform(multipart("/api/branding/logo")
                        .file(bigFile)
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isBadRequest());
    }

    // ---- GET /api/branding/logo ----

    @Test
    void getLogo_returnsNotFoundWhenNoLogo() throws Exception {
        mvc.perform(get("/api/branding/logo")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isNotFound());
    }

    @Test
    void getLogo_returnsImageAfterUpload() throws Exception {
        var pngBytes = minimalPng();
        var file = new MockMultipartFile("file", "logo.png", "image/png", pngBytes);
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + proToken));

        mvc.perform(get("/api/branding/logo")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", "image/png"))
                .andExpect(content().bytes(pngBytes));
    }

    // ---- DELETE /api/branding/logo ----

    @Test
    void deleteLogo_freeUserGets402() throws Exception {
        mvc.perform(delete("/api/branding/logo")
                        .header("Authorization", "Bearer " + freeToken))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void deleteLogo_proUserSucceeds() throws Exception {
        // Upload first
        var file = new MockMultipartFile("file", "logo.png", "image/png", minimalPng());
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + proToken));

        mvc.perform(delete("/api/branding/logo")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isNoContent());

        mvc.perform(get("/api/branding")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(jsonPath("$.hasLogo").value(false));
    }

    // ---- helpers ----

    private String registerAndGetToken(String email, String name) throws Exception {
        return register(email, "password123", name);
    }

    private String register(String email, String password, String name) throws Exception {
        var req = new AuthController.RegisterRequest(email, password, name);
        var result = mvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andReturn();
        var node = mapper.readTree(result.getResponse().getContentAsString());
        return node.get("token").asText();
    }

    /** Minimal valid 1x1 PNG (67 bytes). */
    private byte[] minimalPng() {
        return new byte[]{
            (byte)0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, (byte)0x90, 0x77, 0x53,
            (byte)0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
            0x54, 0x08, (byte)0xD7, 0x63, (byte)0xF8, (byte)0xCF, (byte)0xC0, 0x00, 0x00,
            0x00, 0x02, 0x00, 0x01, (byte)0xE2, 0x21, (byte)0xBC, 0x33,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
            (byte)0xAE, 0x42, 0x60, (byte)0x82
        };
    }
}
