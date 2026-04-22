package com.invoiceflow.branding;

import com.invoiceflow.common.PlanLimitException;
import com.invoiceflow.user.User;
import com.invoiceflow.user.UserRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Set;

@RestController
@RequestMapping("/api/branding")
public class BrandingController {

    private static final Set<String> ALLOWED_TYPES =
            Set.of("image/png", "image/jpeg", "image/gif", "image/webp");
    private static final long MAX_LOGO_BYTES = 2L * 1024 * 1024; // 2 MB

    private final UserRepository userRepository;

    public BrandingController(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public record BrandingResponse(String brandColor, boolean hasLogo) {}

    public record ColorRequest(
            @Pattern(regexp = "^#[0-9A-Fa-f]{6}$", message = "Brand color must be a hex value like #2563EB")
            String brandColor) {}

    @GetMapping
    public BrandingResponse get(@AuthenticationPrincipal User user) {
        return new BrandingResponse(effectiveColor(user), user.getLogoData() != null);
    }

    @PutMapping("/color")
    public ResponseEntity<?> updateColor(@AuthenticationPrincipal User user,
                                          @Valid @RequestBody ColorRequest req) {
        requireBranding(user);
        user.setBrandColor(req.brandColor());
        userRepository.save(user);
        return ResponseEntity.ok(new BrandingResponse(user.getBrandColor(), user.getLogoData() != null));
    }

    @PostMapping(value = "/logo", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> uploadLogo(@AuthenticationPrincipal User user,
                                         @RequestParam("file") MultipartFile file) {
        requireBranding(user);
        if (file.isEmpty()) {
            return ResponseEntity.badRequest().body("File is empty");
        }
        String contentType = file.getContentType();
        if (contentType == null || !ALLOWED_TYPES.contains(contentType)) {
            return ResponseEntity.badRequest().body("Accepted formats: PNG, JPEG, GIF, WebP");
        }
        if (file.getSize() > MAX_LOGO_BYTES) {
            return ResponseEntity.badRequest().body("Logo must be under 2 MB");
        }
        try {
            user.setLogoData(file.getBytes());
            user.setLogoContentType(contentType);
            userRepository.save(user);
            return ResponseEntity.ok(new BrandingResponse(effectiveColor(user), true));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body("Upload failed");
        }
    }

    @DeleteMapping("/logo")
    public ResponseEntity<BrandingResponse> deleteLogo(@AuthenticationPrincipal User user) {
        requireBranding(user);
        user.setLogoData(null);
        user.setLogoContentType(null);
        userRepository.save(user);
        return ResponseEntity.ok(new BrandingResponse(effectiveColor(user), false));
    }

    @GetMapping("/logo")
    public ResponseEntity<byte[]> getLogo(@AuthenticationPrincipal User user) {
        if (user.getLogoData() == null) {
            return ResponseEntity.notFound().build();
        }
        MediaType mt = parseMediaType(user.getLogoContentType());
        return ResponseEntity.ok().contentType(mt).body(user.getLogoData());
    }

    // ---- helpers ----

    private void requireBranding(User user) {
        if (!user.getPlan().customBranding) {
            throw new PlanLimitException("Custom branding is available on Pro and Agency plans");
        }
    }

    private String effectiveColor(User user) {
        return user.getBrandColor() != null ? user.getBrandColor() : "#2563EB";
    }

    private MediaType parseMediaType(String ct) {
        if (ct == null) return MediaType.IMAGE_PNG;
        return switch (ct) {
            case "image/jpeg" -> MediaType.IMAGE_JPEG;
            case "image/gif"  -> MediaType.IMAGE_GIF;
            default           -> MediaType.IMAGE_PNG;
        };
    }
}
