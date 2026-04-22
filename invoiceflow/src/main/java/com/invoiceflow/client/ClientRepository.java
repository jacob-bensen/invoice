package com.invoiceflow.client;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ClientRepository extends JpaRepository<Client, Long> {
    List<Client> findAllByUserIdOrderByNameAsc(Long userId);
    Optional<Client> findByIdAndUserId(Long id, Long userId);
    long countByUserId(Long userId);
}
