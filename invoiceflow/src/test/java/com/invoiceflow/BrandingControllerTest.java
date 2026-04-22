package com.invoiceflow;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.invoiceflow.auth.AuthController;
import com.invoiceflow.auth.JwtUtil;
import com.invoiceflow.branding.BrandingController;
import com.invoiceflow.user.Plan;
import com.invoiceflow.user.User;
import com.invoiceflow.user.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

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
    @Autowired JwtUtil jwtUtil;
    @Autowired PasswordEncoder passwordEncoder;

    private String freeToken;
    private String proToken;

    @BeforeEach
    void setup() {
        userRepository.deleteAll();

        var freeUser = new User();
        freeUser.setEmail("free@example.com");
        freeUser.setPasswordHash(passwordEncoder.encode("pass1234"));
        freeUser.setFullName("Free User");
        freeUser.setPlan(Plan.FREE);
        userRepository.save(freeUser);
        freeToken = jwtUtil.generate(freeUser.getEmail());

        var proUser = new User();
        proUser.setEmail("pro@example.com");
        proUser.setPasswordHash(passwordEncoder.encode("pass1234"));
        proUser.setFullName("Pro User");
        proUser.setPlan(Plan.PRO);
        userRepository.save(proUser);
        proToken = jwtUtil.generate(proUser.getEmail());
    }

    @Test
    void getReturnsNullBrandingForNewUser() throws Exception {
        mvc.perform(get("/api/branding")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.brandColor").isEmpty())
                .andExpect(jsonPath("$.logoUrl").isEmpty());
    }

    @Test
    void updateBrandColorSucceedsForProUser() throws Exception {
        var req = new BrandingController.BrandingRequest("#FF5733");
        mvc.perform(put("/api/branding")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.brandColor").value("#FF5733"));
    }

    @Test
    void updateBrandColorBlockedForFreeUser() throws Exception {
        var req = new BrandingController.BrandingRequest("#FF5733");
        mvc.perform(put("/api/branding")
                        .header("Authorization", "Bearer " + freeToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void updateBrandColorRejectsInvalidHex() throws Exception {
        var req = new BrandingController.BrandingRequest("notacolor");
        mvc.perform(put("/api/branding")
                        .header("Authorization", "Bearer " + proToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(req)))
                .andExpect(status().isBadRequest());
    }

    @Test
    void uploadLogoBlockedForFreeUser() throws Exception {
        var file = new MockMultipartFile("file", "logo.png",
                "image/png", new byte[]{(byte) 0x89, 0x50, 0x4E, 0x47});
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + freeToken))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void uploadLogoRejectsNonImageContentType() throws Exception {
        var file = new MockMultipartFile("file", "doc.pdf",
                "application/pdf", "PDF content".getBytes());
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isBadRequest());
    }

    @Test
    void uploadLogoRejectsFileTooLarge() throws Exception {
        byte[] big = new byte[3 * 1024 * 1024]; // 3 MB
        var file = new MockMultipartFile("file", "big.png", "image/png", big);
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isBadRequest());
    }

    @Test
    void uploadLogoSucceedsForProUser() throws Exception {
        // Minimal 1x1 PNG
        byte[] png = {(byte)0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,
                0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
                0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
                0x08,0x02,0x00,0x00,0x00,0x58,0x79,0x53,
                0x6A,0x00,0x00,0x00,0x0C,0x49,0x44,0x41,
                0x54,0x08,(byte)0xD7,0x63,(byte)0xF8,(byte)0xFF,(byte)0xFF,0x3F,0x00,
                0x05,(byte)0xFE,0x02,(byte)0xFE,(byte)0xA3,0x5C,0x71,0x21,
                0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,
                (byte)0xAE,0x42,0x60,(byte)0x82};

        var file = new MockMultipartFile("file", "logo.png", "image/png", png);
        mvc.perform(multipart("/api/branding/logo")
                        .file(file)
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.logoUrl").isNotEmpty());
    }

    @Test
    void deleteLogoSucceedsForProUser() throws Exception {
        mvc.perform(delete("/api/branding/logo")
                        .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.logoUrl").isEmpty());
    }

    @Test
    void unauthenticatedRequestIsRejected() throws Exception {
        mvc.perform(get("/api/branding"))
                .andExpect(status().isForbidden());
    }
}
