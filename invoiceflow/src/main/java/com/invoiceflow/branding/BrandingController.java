package com.invoiceflow.branding;

import com.invoiceflow.user.User;
import com.invoiceflow.user.UserRepository;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Base64;
import java.util.Map;

@RestController
@RequestMapping("/api/branding")
public class BrandingController {

    private static final int MAX_LOGO_BYTES = 200 * 1024;
    private static final String HEX_COLOR_PATTERN = "^#[0-9A-Fa-f]{6}$";

    private final UserRepository userRepository;

    public BrandingController(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public record BrandingResponse(String brandColor, boolean hasLogo) {}

    @GetMapping
    public BrandingResponse get(@AuthenticationPrincipal User user) {
        return new BrandingResponse(user.getBrandColor(), user.getLogoData() != null);
    }

    @PutMapping("/color")
    public ResponseEntity<?> updateColor(@AuthenticationPrincipal User user,
                                          @RequestBody Map<String, String> body) {
        if (!user.getPlan().customBranding) {
            return ResponseEntity.status(402)
                    .body(Map.of("error", "Custom branding requires Pro plan.", "upgrade", "true"));
        }
        String color = body.get("brandColor");
        if (color == null || !color.matches(HEX_COLOR_PATTERN)) {
            return ResponseEntity.badRequest()
                    .body(Map.of("error", "brandColor must be a 6-digit hex color (e.g. #FF5733)"));
        }
        user.setBrandColor(color);
        userRepository.save(user);
        return ResponseEntity.ok(new BrandingResponse(user.getBrandColor(), user.getLogoData() != null));
    }

    @PostMapping(value = "/logo", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> uploadLogo(@AuthenticationPrincipal User user,
                                         @RequestParam("file") MultipartFile file) {
        if (!user.getPlan().customBranding) {
            return ResponseEntity.status(402)
                    .body(Map.of("error", "Custom branding requires Pro plan.", "upgrade", "true"));
        }
        if (file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "No file provided"));
        }
        String contentType = file.getContentType();
        if (contentType == null
                || (!contentType.equals("image/png") && !contentType.equals("image/jpeg"))) {
            return ResponseEntity.badRequest().body(Map.of("error", "Logo must be a PNG or JPEG image"));
        }
        if (file.getSize() > MAX_LOGO_BYTES) {
            return ResponseEntity.badRequest().body(Map.of("error", "Logo must be under 200 KB"));
        }
        try {
            String base64 = "data:" + contentType + ";base64,"
                    + Base64.getEncoder().encodeToString(file.getBytes());
            user.setLogoData(base64);
            userRepository.save(user);
            return ResponseEntity.ok(new BrandingResponse(user.getBrandColor(), true));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", "Failed to process logo"));
        }
    }

    @DeleteMapping("/logo")
    public ResponseEntity<?> deleteLogo(@AuthenticationPrincipal User user) {
        if (!user.getPlan().customBranding) {
            return ResponseEntity.status(402)
                    .body(Map.of("error", "Custom branding requires Pro plan.", "upgrade", "true"));
        }
        user.setLogoData(null);
        userRepository.save(user);
        return ResponseEntity.ok(new BrandingResponse(user.getBrandColor(), false));
    }
}
