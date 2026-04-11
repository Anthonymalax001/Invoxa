\# Invoxa — SaaS Invoicing Platform



Invoxa is a full-stack multi-tenant SaaS invoicing platform built specifically for Kenyan small and medium businesses (SMEs). It solves a real problem — most Kenyan businesses still send invoices via WhatsApp images or handwritten receipts. Invoxa gives them a professional system to create invoices, manage clients, collect payments via M-Pesa, and track their revenue — all in one place.



\## The Problem It Solves

\- Small businesses in Kenya lose money because they don't track invoices properly

\- Following up on unpaid invoices is manual and embarrassing

\- Accepting payments requires sharing till numbers manually

\- No visibility into how much money the business is making



\## How Invoxa Fixes This

\- Create professional invoices in seconds with automatic VAT calculation

\- Send M-Pesa payment requests directly from the invoice — customer gets a prompt on their phone

\- Download invoices as professional PDFs to send to clients

\- Dashboard shows total revenue, pending payments and overdue invoices at a glance

\- System automatically marks invoices as overdue when due date passes



\## Features

\- Multi-tenant architecture — multiple businesses can sign up, each sees only their own data

\- Client management — add, edit and delete clients

\- Invoice creation with line items, quantity, unit price and 16% Kenya VAT

\- M-Pesa STK Push integration via Safaricom Daraja API

\- PDF invoice generation with business branding

\- Auto overdue detection based on due date

\- Revenue dashboard with 6-month bar chart

\- JWT authentication with role-based access



\## Tech Stack

\- \*\*Frontend:\*\* React, Vite, Tailwind CSS, Recharts

\- \*\*Backend:\*\* Node.js, Express.js REST API

\- \*\*Database:\*\* PostgreSQL hosted on Neon

\- \*\*Payments:\*\* Safaricom Daraja API (M-Pesa Express STK Push)

\- \*\*PDF Generation:\*\* PDFKit

\- \*\*Authentication:\*\* JSON Web Tokens (JWT)



\## System Architecture

\- Frontend (React) talks to Backend (Node/Express) via REST API

\- Backend connects to PostgreSQL on Neon for data storage

\- Every database table has a tenant\_id column for data isolation

\- M-Pesa payments flow: Frontend → Backend → Daraja API → Customer Phone → Callback → Database update



\## Setup \& Installation



\### Prerequisites

\- Node.js v18+

\- PostgreSQL database (Neon)

\- Safaricom Developer account for M-Pesa



\### Backend

```bash

cd server

npm install

cp .env.example .env

npm run dev

```



\### Frontend

```bash

cd client

npm install

npm run dev

```



\### Environment Variables

Create a `server/.env` file with:

