package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/mux"
	"github.com/joho/godotenv"

	"github.com/whatsapp-automation/worker/internal/api"
	"github.com/whatsapp-automation/worker/internal/fingerprint"
)

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		log.Printf("[%s] %s %s", r.Method, r.URL.Path, r.RemoteAddr)
		next.ServeHTTP(w, r)
		log.Printf("[%s] %s completed in %v", r.Method, r.URL.Path, time.Since(start))
	})
}

func main() {
	// Load .env file if present (for local development)
	_ = godotenv.Load()

	workerID := getEnv("WORKER_ID", "worker-1")
	deviceSeed := getEnv("DEVICE_SEED", "default-seed")
	proxyCountry := getEnv("PROXY_COUNTRY", "US")
	port := getEnv("WORKER_PORT", "3001")

	// Generate deterministic fingerprint from seed
	fp := fingerprint.Generate(deviceSeed, proxyCountry)

	log.Printf("=== WhatsApp Worker Starting ===")
	log.Printf("Worker ID:     %s", workerID)
	log.Printf("Proxy Country: %s", proxyCountry)
	log.Printf("Device Seed:   %s", deviceSeed)
	log.Printf("Device ID:     %s", fp.DeviceID)
	log.Printf("MAC Address:   %s", fp.MACAddress)
	log.Printf("Computer Name: %s", fp.ComputerName)
	log.Printf("Timezone:      %s", fp.Timezone)
	log.Printf("Language:      %s", fp.Language)
	log.Printf("================================")

	server, err := api.NewServer(workerID, deviceSeed, proxyCountry, fp)
	if err != nil {
		log.Fatalf("Failed to initialize worker server: %v", err)
	}

	router := mux.NewRouter()
	router.Use(loggingMiddleware)
	server.RegisterRoutes(router)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("Worker %s listening on port %s", workerID, port)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}
