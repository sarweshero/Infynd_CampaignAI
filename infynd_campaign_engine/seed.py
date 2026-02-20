import random
import psycopg2
from faker import Faker
from datetime import datetime, timedelta

# -------------------------
# CONFIGURATION
# -------------------------

DB_CONFIG = {
    "host": "localhost",
    "database": "infynd",
    "user": "postgres",
    "password": "1",
    "port": 5432
}

TOTAL_RECORDS = 150  # Change this to seed more

fake = Faker()

# -------------------------
# STATIC DATA POOLS
# -------------------------

LOCATIONS = [
    "India", "USA", "UK", "Germany", "UAE",
    "Canada", "Australia", "Singapore", "Remote",
    "usa", "india", "San Francisco", "New York", "Austin", "Seattle", "Boston", "Chicago", "London", "Toronto", "Los Angeles", "San Jose", "Chennai"
]

ROLES = [
    "CEO", "CTO", "Software Developer", "HR Manager",
    "Marketing Director", "Sales Head", "Founder",
    "Intern", "Consultant", "Product Manager",
    "Data Scientist", "DevOps Engineer", "Senior Developer", "Lead Developer", "VP Engineering", "Platform Engineer", "Technical Director", "ML Engineer", "Backend Developer", "Developer"
]

CATEGORIES = [
    "SaaS", "FinTech", "Healthcare", "EdTech",
    "AI", "Retail", "Enterprise", "Marketing",
    "Human Resources", "Technology", "Finance"
]

COMPANIES = [
    "TechWave Solutions", "FinVision Inc",
    "InnovateX AI", "NextGen Startup",
    "Alpha-Beta & Co.", "DevLabs UK",
    "RetailHub MiddleEast", "EduSpark Pvt Ltd",
    "BigCorp Ltd", "CloudNova Systems", "TechCorp", "CloudBase", "DevStudio", "StartupXYZ", "Enterprise Co", "SaaS Platform", "FinTech Ltd", "HealthApp", "RetailTech", "AI Company", "InFynd"
]

# For callanswerrate, the schema expects a float (not High/Medium/Low)
CALL_ANSWER_RATE = [round(random.uniform(0.1, 1.0), 2) for _ in range(10)]

PREFERRED_TIMES = ["Morning", "Afternoon", "Evening", "Night"]

# -------------------------
# DATA GENERATION
# -------------------------

def maybe_null(value, probability=0.05):
    return None if random.random() < probability else value

def generate_contact():
    email = fake.unique.email()
    name = fake.name()
    role = random.choice(ROLES)
    company = random.choice(COMPANIES)
    location = random.choice(LOCATIONS)
    category = random.choice(CATEGORIES)
    emailclickrate = maybe_null(round(random.uniform(0.0, 1.0), 2))
    linkedinclickrate = maybe_null(round(random.uniform(0.0, 1.0), 2))
    callanswerrate = maybe_null(random.choice(CALL_ANSWER_RATE))
    preferredtime = maybe_null(random.choice(PREFERRED_TIMES))
    created_at = datetime.now() - timedelta(days=random.randint(0, 365))
    updated_at = created_at + timedelta(days=random.randint(0, 30))
    return (
        email,
        name,
        role,
        company,
        location,
        category,
        emailclickrate,
        linkedinclickrate,
        callanswerrate,
        preferredtime,
        created_at,
        updated_at
    )

# -------------------------
# DATABASE INSERTION
# -------------------------

def seed_database():
    conn = psycopg2.connect(**DB_CONFIG)
    cursor = conn.cursor()

    insert_query = """
    INSERT INTO contacts (
        email, name, role, company, location, category,
        emailclickrate, linkedinclickrate, callanswerrate, preferredtime,
        created_at, updated_at
    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (email) DO NOTHING;
    """

    data_batch = [generate_contact() for _ in range(TOTAL_RECORDS)]

    cursor.executemany(insert_query, data_batch)
    conn.commit()

    cursor.close()
    conn.close()

    print(f"Successfully inserted {TOTAL_RECORDS} records into contacts table.")

# -------------------------
# RUN
# -------------------------

if __name__ == "__main__":
    seed_database()
