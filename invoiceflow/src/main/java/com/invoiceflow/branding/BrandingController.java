package com.invoiceflow.branding;

import com.invoiceflow.common.PlanLimitException;
import com.invoiceflow.config.AppProperties;
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

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.Set;

@RestController
@RequestMapping("/api/branding")
public class BrandingController {

    private static final Set<String> ALLOWED_MIME_TYPES = Set.of(
            "image/png", "image/jpeg", "image/gif", "image/webp");
    private static final long MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

    private final UserRepository userRepository;
    private final AppProperties props;

    public BrandingController(UserRepository userRepository, AppProperties props) {
        this.userRepository = userRepository;
        this.props = props;
    }

    public record BrandingRequest(
            @Pattern(regexp = "^#[0-9A-Fa-f]{6}$", message = "brand_color must be a valid hex color (#RRGGBB)")
            String brandColor) {}

    public record BrandingResponse(String brandColor, String logoUrl) {}

    @GetMapping
    public BrandingResponse get(@AuthenticationPrincipal User user) {
        return new BrandingResponse(user.getBrandColor(), buildPublicLogoUrl(user));
    }

    @PutMapping
    public ResponseEntity<?> updateBrandColor(@AuthenticationPrincipal User user,
                                               @Valid @RequestBody BrandingRequest req) {
        requireProOrAbove(user);
        user.setBrandColor(req.brandColor());
        userRepository.save(user);
        return ResponseEntity.ok(new BrandingResponse(user.getBrandColor(), buildPublicLogoUrl(user)));
    }

    @PostMapping(value = "/logo", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> uploadLogo(@AuthenticationPrincipal User user,
                                         @RequestParam("file") MultipartFile file) {
        requireProOrAbove(user);

        String contentType = file.getContentType();
        if (contentType == null || !ALLOWED_MIME_TYPES.contains(contentType)) {
            return ResponseEntity.badRequest().body("Unsupported file type. Use PNG, JPEG, GIF, or WebP.");
        }
        if (file.getSize() > MAX_LOGO_BYTES) {
            return ResponseEntity.badRequest().body("Logo must be 2 MB or smaller.");
        }

        String ext = switch (contentType) {
            case "image/png"  -> "png";
            case "image/gif"  -> "gif";
            case "image/webp" -> "webp";
            default           -> "jpg";
        };

        String relativePath = "logos/" + user.getId() + "." + ext;
        Path dest = Paths.get(props.getUploadsDir()).resolve(relativePath);

        try {
            Files.createDirectories(dest.getParent());
            file.transferTo(dest);
        } catch (IOException e) {
            return ResponseEntity.internalServerError().body("Failed to save logo: " + e.getMessage());
        }

        user.setLogoUrl(relativePath);
        userRepository.save(user);

        return ResponseEntity.ok(Map.of("logoUrl", buildPublicLogoUrl(user)));
    }

    @DeleteMapping("/logo")
    public ResponseEntity<?> deleteLogo(@AuthenticationPrincipal User user) {
        requireProOrAbove(user);
        if (user.getLogoUrl() != null) {
            try {
                Files.deleteIfExists(Paths.get(props.getUploadsDir()).resolve(user.getLogoUrl()));
            } catch (IOException ignored) {}
            user.setLogoUrl(null);
            userRepository.save(user);
        }
        return ResponseEntity.ok(new BrandingResponse(user.getBrandColor(), null));
    }

    private void requireProOrAbove(User user) {
        if (user.getPlan() != Plan.PRO && user.getPlan() != Plan.AGENCY) {
            throw new PlanLimitException("Custom branding requires a Pro or Agency plan.");
        }
    }

    private String buildPublicLogoUrl(User user) {
        if (user.getLogoUrl() == null) return null;
        return props.getBaseUrl() + "/uploads/" + user.getLogoUrl();
    }
}
