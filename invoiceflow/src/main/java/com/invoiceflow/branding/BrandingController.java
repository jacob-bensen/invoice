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

import java.io.IOException;
import java.time.Instant;
import java.util.Map;
import java.util.Set;

@RestController
@RequestMapping("/api/branding")
public class BrandingController {

    private static final long MAX_LOGO_BYTES = 2L * 1024 * 1024;
    private static final Set<String> ALLOWED_TYPES = Set.of("image/png", "image/jpeg");

    private final UserRepository userRepository;
    private final UserLogoRepository userLogoRepository;

    public BrandingController(UserRepository userRepository, UserLogoRepository userLogoRepository) {
        this.userRepository = userRepository;
        this.userLogoRepository = userLogoRepository;
    }

    public record BrandingSettingsRequest(
            @Pattern(regexp = "^#[0-9A-Fa-f]{6}$", message = "Must be a valid hex color, e.g. #2563eb")
            String brandColor,
            String companyName,
            String companyAddress,
            String companyPhone,
            String companyWebsite) {}

    public record BrandingResponse(
            String brandColor,
            String companyName,
            String companyAddress,
            String companyPhone,
            String companyWebsite,
            boolean hasLogo) {}

    @GetMapping
    public BrandingResponse get(@AuthenticationPrincipal User user) {
        return toBrandingResponse(user);
    }

    @PutMapping
    public ResponseEntity<?> update(@AuthenticationPrincipal User user,
                                     @Valid @RequestBody BrandingSettingsRequest req) {
        requireCustomBranding(user);
        if (req.brandColor() != null) user.setBrandColor(req.brandColor());
        user.setCompanyName(req.companyName());
        user.setCompanyAddress(req.companyAddress());
        user.setCompanyPhone(req.companyPhone());
        user.setCompanyWebsite(req.companyWebsite());
        userRepository.save(user);
        return ResponseEntity.ok(toBrandingResponse(user));
    }

    @PostMapping(value = "/logo", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> uploadLogo(@AuthenticationPrincipal User user,
                                         @RequestParam("file") MultipartFile file) throws IOException {
        requireCustomBranding(user);
        if (file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "File is empty"));
        }
        if (file.getSize() > MAX_LOGO_BYTES) {
            return ResponseEntity.badRequest().body(Map.of("error", "Logo must be 2 MB or smaller"));
        }
        String contentType = file.getContentType();
        if (contentType == null || !ALLOWED_TYPES.contains(contentType)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Only PNG and JPEG logos are accepted"));
        }
        UserLogo logo = userLogoRepository.findById(user.getId()).orElse(new UserLogo());
        // Use a managed reference so @MapsId works when logo is new
        logo.setUser(userRepository.getReferenceById(user.getId()));
        logo.setLogoData(file.getBytes());
        logo.setContentType(contentType);
        logo.setUpdatedAt(Instant.now());
        userLogoRepository.save(logo);
        return ResponseEntity.ok(Map.of("message", "Logo uploaded"));
    }

    @DeleteMapping("/logo")
    public ResponseEntity<?> deleteLogo(@AuthenticationPrincipal User user) {
        requireCustomBranding(user);
        userLogoRepository.deleteById(user.getId());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/logo")
    public ResponseEntity<byte[]> getLogo(@AuthenticationPrincipal User user) {
        return userLogoRepository.findById(user.getId())
                .map(logo -> ResponseEntity.ok()
                        .contentType(MediaType.parseMediaType(logo.getContentType()))
                        .body(logo.getLogoData()))
                .orElse(ResponseEntity.notFound().build());
    }

    private BrandingResponse toBrandingResponse(User user) {
        return new BrandingResponse(
                user.getBrandColor(),
                user.getCompanyName(),
                user.getCompanyAddress(),
                user.getCompanyPhone(),
                user.getCompanyWebsite(),
                userLogoRepository.existsById(user.getId()));
    }

    private void requireCustomBranding(User user) {
        if (!user.getPlan().customBranding) {
            throw new PlanLimitException("Custom branding requires a Pro or Agency plan. Please upgrade.");
        }
    }
}
