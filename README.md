<div align="center">
  <h1>☢️ Nuclid</h1>
  <p><b>A browser-only gamma-ray spectroscopy app built with TypeScript + Vite.</b></p>
  <p>
    <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E" alt="Vite" />
    <img src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel" />
  </p>
</div>

---

## 🌟 Overview

**Nuclid v4** takes a raw spectrum from a scintillation detector and walks it toward an identified radionuclide—showing every step a reviewer would check. **Nothing is installed, and your data never leaves your machine.**

*v4 is a clean re-architecture.* It brings the same science and philosophy as v3 but rebuilt as a small set of pure stage functions behind general, element-agnostic interfaces. 

> **🎯 North Star:** From raw spectrum to identified nuclide — *every step shown.*  
> **⚠️ Note:** This project is under active development; downstream numbers are not yet validated.

---

## ⚙️ The Pipeline

```mermaid
graph LR
A[Load] --> B[Condition] --> C[Detect] --> D[Fit] --> E[Validate] --> F[Calibrate] --> G[Identify] --> H[Quantify] --> I[Report]
