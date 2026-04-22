package com.invoiceflow.client;

import com.invoiceflow.common.PlanLimitException;
import com.invoiceflow.user.User;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/clients")
public class ClientController {

    private final ClientRepository clientRepository;

    public ClientController(ClientRepository clientRepository) {
        this.clientRepository = clientRepository;
    }

    public record ClientRequest(
            @NotBlank String name,
            @NotBlank @Email String email,
            String company,
            String address) {}

    public record ClientResponse(Long id, String name, String email, String company, String address) {}

    private ClientResponse toResponse(Client c) {
        return new ClientResponse(c.getId(), c.getName(), c.getEmail(), c.getCompany(), c.getAddress());
    }

    @GetMapping
    public List<ClientResponse> list(@AuthenticationPrincipal User user) {
        return clientRepository.findAllByUserIdOrderByNameAsc(user.getId())
                .stream().map(this::toResponse).toList();
    }

    @PostMapping
    public ResponseEntity<?> create(@AuthenticationPrincipal User user,
                                     @Valid @RequestBody ClientRequest req) {
        long count = clientRepository.countByUserId(user.getId());
        if (count >= user.getPlan().maxClients) {
            throw new PlanLimitException("Client limit reached for your plan. Please upgrade.");
        }
        var client = new Client();
        client.setUser(user);
        client.setName(req.name());
        client.setEmail(req.email());
        client.setCompany(req.company());
        client.setAddress(req.address());
        return ResponseEntity.ok(toResponse(clientRepository.save(client)));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ClientResponse> get(@AuthenticationPrincipal User user, @PathVariable Long id) {
        return clientRepository.findByIdAndUserId(id, user.getId())
                .map(c -> ResponseEntity.ok(toResponse(c)))
                .orElse(ResponseEntity.notFound().build());
    }

    @PutMapping("/{id}")
    public ResponseEntity<?> update(@AuthenticationPrincipal User user,
                                     @PathVariable Long id,
                                     @Valid @RequestBody ClientRequest req) {
        return clientRepository.findByIdAndUserId(id, user.getId())
                .map(c -> {
                    c.setName(req.name());
                    c.setEmail(req.email());
                    c.setCompany(req.company());
                    c.setAddress(req.address());
                    return ResponseEntity.ok(toResponse(clientRepository.save(c)));
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@AuthenticationPrincipal User user, @PathVariable Long id) {
        return clientRepository.findByIdAndUserId(id, user.getId())
                .map(c -> {
                    clientRepository.delete(c);
                    return ResponseEntity.noContent().build();
                })
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
