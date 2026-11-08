# 🧠📈 Coin Sniper – Trade Smart on New Listings

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## 📝 Description

Based on similar trading logic written into the tool here: [CyberPunkMetalHead/new-listings-trading-bot](https://github.com/CyberPunkMetalHead/new-listings-trading-bot) (taken from the excellent article [here](https://medium.com/coinmonks/i-made-an-open-source-trading-bot-that-trades-new-coin-listings-within-seconds-a529402b2cdd)).

📈 History tells us that coins newly announced on Binance often enjoy a short-term spike in buying activity, causing a sharp rise in price! This bot aims to catch that momentum.

🧠 Unlike the original, this version introduces AI-based decision-making and supports a wide range of exchanges. It also reacts to delisting announcements by preparing to short the delisted coin.

---

## 📁 Project Structure

```
src
├── main
│   ├── java
│   │   └── com.richieloco.coinsniper
│   │       ├── config              # Spring, YAML, AI, security, and exchange config
│   │       ├── controller          # API & dashboard controllers
│   │       ├── entity              # R2DBC entities (TradeDecisionRecord, CoinAnnouncementRecord, ExchangeAssessmentRecord, ErrorResponseRecord, etc.)
│   │       ├── ex                  # Custom exceptions
│   │       ├── model               # Binance & exchange DTOs
│   │       ├── repository          # Reactive R2DBC repositories
│   │       └── service             # AI, polling, exchange integration, training, RL
│   └── resources
│       └── application.yml         # Config file
└── test
    └── java
        └── com.richieloco.coinsniper
            ├── config              # Test configuration
            ├── controller          # Controller unit tests
            ├── it                  # Integration tests (Binance, polling, dashboard, backtesting)
            └── service             # Service + AI logic tests
```

---

## 🤖 AI-based Filtering

The bot polls Binance's Announcement API and then intelligently filters down potential exchanges based on multiple ChatGPT evaluations.

### 🔍 Filtering Breakdown

➡️ From:

```
<Configured supported exchanges>
```

➡️ To:

```
<Matched exchanges listing the newly announced Binance coin>
```

➡️ From:

```
<Multiple ChatGPT-based risk assessment calls on matched exchanges>
```

➡️ To:

```
<The single exchange we will trade with>
```

➡️ To:

```
<Persisted trade decision + error logging>
```

➡️ To:

```
<Reinforcement learning + backtesting module input>
```

---

## 💾 Persistence Layer

The bot persists all relevant data into a **PostgreSQL database via Spring Data R2DBC**:

* **Trade Decisions** (with risk scores + execution status)  
* **Binance Announcements** (raw + parsed)  
* **Exchange Assessments** (AI evaluation results)  
* **Error Responses** (API failure cases for diagnostics)  

These are accessible via:

* `/dashboard` (Thymeleaf UI with trades, announcements, risk assessments, error responses)  
* `/backtesting` (historical trades + DJL training charts)  
* `/actuator/configprops` (Spring Boot insights)  

---

## 🧠 Deep Learning & Reinforcement Learning

The bot integrates with [Deep Java Library (DJL)](https://djl.ai/) for ML/RL:

- 📊 **Training pipeline** with loss/accuracy tracking  
- 🔄 **Continued training** (resume from saved models, accumulate epochs)  
- 🧩 **Custom summaries** (model architecture, optimizer, final loss/accuracy, hyperparameters)  
- 🎯 **Reinforcement learning loop** with reward functions for trade outcomes  
- 🧠 **AI-driven strategy updates** based on backtesting results  

---

## 📡 Exchange & Risk Management

- Multi-exchange support (Binance, Bybit, Poloniex – extensible via `ExchangeAssessor` & `AssessmentFunction`)  
- Real-time **risk assessment via Spring AI** with LLM providers (OpenAI, Groq, etc.)  
- **Runtime strategy updates**: AI models adapt based on backtesting data   
- **CSV logging** of executed trades for external analysis  

---

## 🔁 Continuous Polling

The app supports live polling of the Binance announcements endpoint.  

Use the API endpoints:

* `POST /api/announcements/poll/start` ➡️ Start polling (non-reactive Java scheduler)  
* `POST /api/announcements/poll/stop` ➡️ Stop polling  
* `GET /api/announcements/poll/status` ➡️ Check polling status  

---

## 🔐 Security

- **Spring Security (Spring Boot 3.4.3, Spring Security 6.1)**  
- Uses `SecurityFilterChain` instead of deprecated `httpBasic()` / `formLogin()`  
- **JWT session management** with automatic token refresh (8h expiration)  
- **OAuth2 support** for secure API key storage (OpenAI, exchange APIs)  

---

## 🌱 Spring Profiles

Use `SPRING_PROFILES_ACTIVE=prod` to activate production-grade polling.

Other profiles:

- `test` ➡️ Unit/integration tests with `NoSecurityTestConfig`  
- `dev`  ➡️ Hot reload + debug-friendly configuration  

---

## 🌐 Thymeleaf Dashboard Access

Access UI pages at:

* `http://localhost:8080/dashboard` ➡️ 📊 Recent trades, announcements, risk assessments, error responses  
* `http://localhost:8080/backtesting` ➡️ 📉 Backtesting results + DJL training charts  

---

## 🧪 Running Tests

Unit and integration tests use **JUnit 5**, **Mockito (@Mock instead of @MockBean)**, and **StepVerifier**.  

To run all tests:

```bash
./mvnw test
```

To view test coverage (if JaCoCo is configured):

```bash
./mvnw jacoco:report
open target/site/jacoco/index.html
```

To run integration tests (e.g. classes in `com.richieloco.coinsniper.it`):

```bash
./mvnw verify -Pintegration-tests
```

### ✅ Test Coverage

- `AnnouncementCallingServiceTest` ➡️ Mocked + error handling scenarios  
- `AnnouncementPollingSchedulerTest` ➡️ Poll start/stop lifecycle (non-reactive scheduler)  
- `ExchangeRiskAssessorTest` ➡️ AI risk assessment via BaseAssessor/AssessmentFunction  
- `DJLTrainingServiceTest` ➡️ Training continuation + model save/load + summaries  
- `DashboardControllerTest` & `BacktestingControllerTest` ➡️ Unit tests  
- `DashboardIntegrationTest` & `BacktestingIntegrationTest` ➡️ End-to-end validation with WebTestClient  

---

## 🧩 Kubernetes Deployment

### 🛠️ Prerequisites

* Java 21 JDK  
* Docker or Podman  
* Kubernetes cluster (k3s, kind, or managed cloud)  

### 🧰 Deployment Steps

```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

Visit: `http://<k8s-node-ip>:<nodePort>`

✅ Add `Ingress` + Cloudflare Tunnel + TLS for secure external access.

---

## 🍓 Raspberry Pi & Home-Lab Deployment

Tested on:

- **Raspberry Pi 5** (8 GB RAM, 512 SSD)  
- **Minisforum N5 Pro** (96 GB RAM, 56 TB storage, SSD + SATA)
- **Minisforum V3** (32 GB RAM, 1 TB storage)

### 📦 Steps

```bash
# On Raspberry Pi / ARM server
sudo apt install openjdk-21-jdk
java -jar coin-sniper.jar
```

Or build for ARM:

```bash
./mvnw clean package
scp target/coin-sniper.jar pi@raspberrypi:/home/pi
```

For self-hosting with domain + SSL:  
- Use **Cloudflare Tunnel** (no router port-forwarding needed)  
- Or use **Nginx Proxy Manager** (on Pi or VM) with DNS → Cloudflare  

---

## 🐳 Docker & Docker Compose Deployment

### Build & Run (single container)

```bash
docker build -t coin-sniper .
docker run -e SPRING_PROFILES_ACTIVE=prod -e OPENAI_API_KEY=sk-xxxxxxxx -p 8080:8080 coin-sniper
```

### Docker Compose

A `docker-compose.yml` is included with services:  

- **coin-sniper** (Spring Boot app)  
- **PostgreSQL (R2DBC)** for persistence  
- **Adminer** for DB inspection  
- Optional: Nginx Proxy Manager for reverse proxy + TLS  

```bash
docker compose up -d
```

---

## 🔧 Configuration Example (application.yml)

```yaml
spring:
  r2dbc:
    url: r2dbc:postgresql://db:5432/coinsniper
    username: coinsniper
    password: ${POSTGRES_PASSWORD}
  ai:
    openai:
      api-key: ${OPENAI_API_KEY} # 🔐 from env
coin-sniper:
  supported:
    exchanges:
      - Binance
      - Bybit
      - Poloniex
  stable-coins:
      - USDT
      - USDC
  api:
    binance:
      announcement:
        base-url: https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query
  polling:
    enabled: true
    interval-seconds: 30
```

---

## 📧 Notifications

- **Email alerts** for trade executions & errors (configurable via SMTP in Spring Mail)  
- Weekly **performance summary reports** (total trades, win rate, PnL, drawdown)  
- Planned: 📊 **Equity curve chart** embedded in weekly email  

---

## 🔐 Set Your API Key Securely

Set the `OPENAI_API_KEY` environment variable in your terminal or CI environment:

**Linux/macOS:**

```bash
export OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Windows CMD:**

```cmd
set OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Windows PowerShell:**

```powershell
$env:OPENAI_API_KEY = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

---

## ⏭️ TODO

1. Wiring into the APIs of the exchanges of which trading decisions have been made.
2. Email alerts capturing announcements, trading decisions and any errors (via Spring Mail SMTP)
3. Non-volatile DB storage

---

## 🤝 Contributing

Contributions are welcome!

1. Fork the repo  
2. Create your feature branch (`git checkout -b feature/your-feature`)  
3. Commit your changes (`git commit -am 'Add new feature'`)  
4. Push to the branch (`git push origin feature/your-feature`)  
5. Open a Pull Request 🚀  

---

## 📝 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

🧠 Built with Spring Boot WebFlux, R2DBC (PostgreSQL), DJL (Deep Learning), Spring AI, Docker, Kubernetes, and OpenAPI 3  
💬 Suggestions and contributions welcome!
