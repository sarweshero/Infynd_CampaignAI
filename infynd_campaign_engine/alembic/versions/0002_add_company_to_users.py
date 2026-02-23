"""add company to users table

Revision ID: 0002_add_company_to_users
Revises: 0001_create_users
Create Date: 2026-02-23
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0002_add_company_to_users"
down_revision = "0001_create_users"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("company", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "company")
