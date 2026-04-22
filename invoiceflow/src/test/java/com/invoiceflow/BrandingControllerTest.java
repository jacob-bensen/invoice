package com.invoiceflow;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.invoiceflow.auth.AuthController;
import com.invoiceflow.auth.JwtUtil;
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

import java.util.Map;

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

    private String freeToken;
    private String proToken;
    private static final String FREE_EMAIL = "branding-free@example.com";
    private static final String PRO_EMAIL  = "branding-pro@example.com";

    @BeforeEach
    void setup() throws Exception {
        userRepository.findByEmail(FREE_EMAIL).ifPresent(userRepository::delete);
        userRepository.findByEmail(PRO_EMAIL).ifPresent(userRepository::delete);

        // Register free user
        mvc.perform(post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(
                        new AuthController.RegisterRequest(FREE_EMAIL, "password123", "Free User"))))
                .andExpect(status().isOk());
        freeToken = jwtUtil.generate(FREE_EMAIL);

        // Register pro user and elevate plan
        mvc.perform(post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(
                        new AuthController.RegisterRequest(PRO_EMAIL, "password123", "Pro User"))))
                .andExpect(status().isOk());
        userRepository.findByEmail(PRO_EMAIL).ifPresent(u -> {
            u.setPlan(Plan.PRO);
            userRepository.save(u);
        });
        proToken = jwtUtil.generate(PRO_EMAIL);
    }

    @Test
    void getDefaultBranding() throws Exception {
        mvc.perform(get("/api/branding")
                .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasLogo").value(false))
                .andExpect(jsonPath("$.brandColor").doesNotExist());
    }

    @Test
    void freeUserCannotSetColor() throws Exception {
        mvc.perform(put("/api/branding/color")
                .header("Authorization", "Bearer " + freeToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of("brandColor", "#FF5733"))))
                .andExpect(status().isPaymentRequired())
                .andExpect(jsonPath("$.upgrade").value("true"));
    }

    @Test
    void proUserSetsAndGetsColor() throws Exception {
        mvc.perform(put("/api/branding/color")
                .header("Authorization", "Bearer " + proToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of("brandColor", "#123ABC"))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.brandColor").value("#123ABC"));

        mvc.perform(get("/api/branding")
                .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.brandColor").value("#123ABC"));
    }

    @Test
    void invalidColorRejected() throws Exception {
        mvc.perform(put("/api/branding/color")
                .header("Authorization", "Bearer " + proToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of("brandColor", "not-a-color"))))
                .andExpect(status().isBadRequest());
    }

    @Test
    void freeUserCannotUploadLogo() throws Exception {
        MockMultipartFile logo = new MockMultipartFile(
                "file", "logo.png", "image/png", new byte[]{1, 2, 3});
        mvc.perform(multipart("/api/branding/logo")
                .file(logo)
                .header("Authorization", "Bearer " + freeToken))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void proUserUploadsAndDeletesLogo() throws Exception {
        // Minimal valid 1x1 PNG bytes
        byte[] pngBytes = new byte[]{
            (byte)0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, (byte)0x90, 0x77, 0x53,
            (byte)0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
            0x54, 0x08, (byte)0xD7, 0x63, (byte)0xF8, (byte)0xFF,
            (byte)0xFF, 0x3F, 0x00, 0x05, (byte)0xFE, 0x02,
            (byte)0xFE, (byte)0xDC, (byte)0xCC, 0x59, (byte)0xE7,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
            (byte)0xAE, 0x42, 0x60, (byte)0x82
        };

        MockMultipartFile logo = new MockMultipartFile(
                "file", "logo.png", "image/png", pngBytes);

        mvc.perform(multipart("/api/branding/logo")
                .file(logo)
                .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasLogo").value(true));

        mvc.perform(get("/api/branding")
                .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasLogo").value(true));

        mvc.perform(delete("/api/branding/logo")
                .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasLogo").value(false));
    }

    @Test
    void logoTooLargeRejected() throws Exception {
        byte[] bigLogo = new byte[201 * 1024];
        MockMultipartFile logo = new MockMultipartFile(
                "file", "big.png", "image/png", bigLogo);
        mvc.perform(multipart("/api/branding/logo")
                .file(logo)
                .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("Logo must be under 200 KB"));
    }

    @Test
    void invalidMimeTypeRejected() throws Exception {
        MockMultipartFile pdf = new MockMultipartFile(
                "file", "doc.pdf", "application/pdf", new byte[]{1, 2, 3});
        mvc.perform(multipart("/api/branding/logo")
                .file(pdf)
                .header("Authorization", "Bearer " + proToken))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("Logo must be a PNG or JPEG image"));
    }
}
