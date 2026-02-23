# InFynd Campaign Engine

A full-stack B2B campaign management platform designed to orchestrate, track, and analyze multi-channel outreach campaigns.

## 🚀 Overview

InFynd Campaign Engine is a modern web application that allows companies to manage their outbound marketing efforts. It features a robust role-based access control (RBAC) system, real-time analytics, and a streamlined campaign creation workflow.

### Key Features

- **Multi-Channel Campaigns:** Create and manage campaigns across Email, LinkedIn, and Phone channels.
- **Role-Based Access Control (RBAC):**
  - **Admin:** Full access to manage users, create/approve campaigns, and view all analytics.
  - **Manager:** Can create, edit, and submit campaigns for approval, plus view analytics.
  - **Viewer:** Read-only access to view campaigns and analytics.
- **Company-Centric Registration:** New companies register an Admin account, who can then invite team members to their workspace.
- **Real-Time Analytics:** Track campaign performance, engagement rates, and channel-specific metrics.
- **Approval Workflows:** Built-in review process for campaigns before they go live.
- **Modern UI/UX:** Responsive, accessible interface built with Next.js and Tailwind CSS, featuring a custom portal-based tooltip system.

---

## 🛠️ Tech Stack

### Frontend
- **Framework:** [Next.js 14](https://nextjs.org/) (App Router)
- **Library:** [React 18](https://react.dev/)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/)
- **Language:** TypeScript
- **State/Data Fetching:** SWR, Axios
- **Icons:** Lucide React (SVG)

### Backend
- **Framework:** [FastAPI](https://fastapi.tiangolo.com/)
- **Language:** Python 3.10+
- **Database:** PostgreSQL
- **ORM:** SQLAlchemy (Async)
- **Migrations:** Alembic
- **Authentication:** JWT (JSON Web Tokens) with Bearer scheme
- **Validation:** Pydantic v2

---

## 📂 Project Structure

```text
InFynd/V1/
├── frontend/                  # Next.js frontend application
│   ├── app/                   # App Router pages and layouts
│   │   ├── dashboard/         # Main application interface (page.tsx)
│   │   ├── globals.css        # Global styles and Tailwind directives
│   │   └── layout.tsx         # Root layout
│   ├── lib/                   # Utilities and API client
│   │   └── api.ts             # Centralized Axios instance and API functions
│   ├── public/                # Static assets
│   └── package.json           # Frontend dependencies
│
├── infynd_campaign_engine/    # FastAPI backend application
│   ├── alembic/               # Database migration scripts
│   ├── app/                   # Main application code
│   │   ├── api/               # Route handlers (auth, admin, campaigns, etc.)
│   │   ├── core/              # Core config, security, and DB setup
│   │   ├── models/            # SQLAlchemy ORM models
│   │   └── schemas/           # Pydantic validation schemas
│   ├── main.py                # FastAPI application entry point
│   ├── alembic.ini            # Alembic configuration
│   └── requirements.txt       # Python dependencies
│
└── .env                       # Environment variables (not tracked in git)
```

---

## ⚙️ Local Development Setup

### Prerequisites
- Node.js (v18+)
- Python (v3.10+)
- PostgreSQL (v14+)

### 1. Database Setup
Ensure PostgreSQL is running and create a database for the project:
```sql
CREATE DATABASE infynd_campaigns;
```

### 2. Backend Setup
Navigate to the backend directory and set up the Python environment:

```bash
cd infynd_campaign_engine

# Create and activate virtual environment
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On macOS/Linux:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Set up environment variables
# Create a .env file in the infynd_campaign_engine directory based on your local DB
# Example: DATABASE_URL=postgresql+asyncpg://user:password@localhost:5432/infynd_campaigns

# Run database migrations
alembic upgrade head

# Start the FastAPI server
uvicorn app.main:app --reload --port 8000
```
The backend API will be available at `http://localhost:8000`.
Interactive API documentation (Swagger UI) is available at `http://localhost:8000/docs`.

### 3. Frontend Setup
Open a new terminal, navigate to the frontend directory, and start the development server:

```bash
cd frontend

# Install dependencies
npm install

# Start the Next.js development server
npm run dev
```
The frontend application will be available at `http://localhost:3000`.

---

## 🔐 Authentication Flow

1. **Company Registration:** A new user registers their company via the frontend. This creates the company workspace and assigns the user the `ADMIN` role.
2. **Login:** Users authenticate with their email and password to receive an Access Token and a Refresh Token.
3. **User Management:** The `ADMIN` can navigate to the "Users" tab in the dashboard to invite new team members (`MANAGER` or `VIEWER`) to their company.
4. **API Security:** All protected backend routes require a valid JWT Bearer token. Role-based endpoints (like `/api/v1/admin/users`) enforce strict permission checks.

---

## 📝 License

Proprietary and Confidential. All rights reserved by InFynd.
