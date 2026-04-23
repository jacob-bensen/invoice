package com.invoiceflow.branding;

import com.invoiceflow.common.PlanLimitException;
import com.invoiceflow.user.Plan;
import com.invoiceflow.user.User;
import com.invoiceflow.user.UserRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Base64;
import java.util.Map;
import java.util.Set;

@RestController
@RequestMapping("/api/branding")
public class BrandingController {

    private static final Set<String> ALLOWED_TYPES =
            Set.of("image/png", "image/jpeg", "image/gif", "image/webp");
    private static final long MAX_LOGO_BYTES = 512 * 1024L; // 512 KB
    private static final Set<String> ALLOWED_MIME = Set.of(
            "image/png", "image/jpeg", "image/gif", "image/webp");

    private final UserRepository userRepository;

    public BrandingController(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public record BrandingResponse(String brandColor, boolean hasLogo) {}

    public record ColorRequest(
            @Pattern(regexp = "^#[0-9A-Fa-f]{6}$", message = "Brand color must be a hex value like #2563EB")
            @Pattern(regexp = "^#[0-9a-fA-F]{6}$", message = "must be a 6-digit hex color, e.g. #2563EB")
            String brandColor) {}

    @GetMapping
    public BrandingResponse get(@AuthenticationPrincipal User user) {
        return new BrandingResponse(user.getBrandColor(), user.getLogoData() != null);
    }

    @PutMapping("/color")
    public ResponseEntity<?> updateColor(@AuthenticationPrincipal User user,
                                         @Valid @RequestBody ColorRequest req) {
        requireBrandingPlan(user);
        user.setBrandColor(req.brandColor());
        userRepository.save(user);
        return ResponseEntity.ok(new BrandingResponse(user.getBrandColor(), user.getLogoData() != null));
    }

    @PostMapping(value = "/logo", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> uploadLogo(@AuthenticationPrincipal User user,
                                        @RequestParam("file") MultipartFile file) {
        requireBrandingPlan(user);

        if (file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "File is empty"));
        }
        if (file.getSize() > MAX_LOGO_BYTES) {
            return ResponseEntity.badRequest().body(Map.of("error", "Logo must be 512 KB or smaller"));
        }
        String mime = file.getContentType();
        if (mime == null || !ALLOWED_MIME.contains(mime)) {
            return ResponseEntity.badRequest().body(
                    Map.of("error", "Unsupported file type. Use PNG, JPEG, GIF, or WebP"));
        }

        try {
            byte[] bytes = file.getBytes();
            user.setLogoData(Base64.getEncoder().encodeToString(bytes));
            user.setLogoMime(mime);
            userRepository.save(user);
            return ResponseEntity.ok(Map.of("hasLogo", true));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", "Failed to store logo"));
        }
    }

    @DeleteMapping("/logo")
    public ResponseEntity<Void> deleteLogo(@AuthenticationPrincipal User user) {
        requireBrandingPlan(user);
        user.setLogoData(null);
        user.setLogoMime(null);
        userRepository.save(user);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/logo")
    public ResponseEntity<byte[]> getLogo(@AuthenticationPrincipal User user) {
        if (user.getLogoData() == null) {
            return ResponseEntity.notFound().build();
        }
        byte[] bytes = Base64.getDecoder().decode(user.getLogoData());
        MediaType mediaType = parseMediaType(user.getLogoMime());
        return ResponseEntity.ok().contentType(mediaType).body(bytes);
    }

    private void requireBrandingPlan(User user) {
        if (user.getPlan() != Plan.PRO && user.getPlan() != Plan.AGENCY) {
            throw new PlanLimitException("Custom branding requires the Pro plan. Please upgrade.");
        }
    }

    private MediaType parseMediaType(String mime) {
        if (mime == null) return MediaType.IMAGE_PNG;
        return switch (mime) {
            case "image/jpeg" -> MediaType.IMAGE_JPEG;
            case "image/gif"  -> MediaType.IMAGE_GIF;
            default           -> MediaType.IMAGE_PNG;
        };
    }
}
