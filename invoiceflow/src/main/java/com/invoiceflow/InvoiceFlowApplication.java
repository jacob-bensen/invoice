package com.invoiceflow;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class InvoiceFlowApplication {
    public static void main(String[] args) {
        SpringApplication.run(InvoiceFlowApplication.class, args);
    }
}
