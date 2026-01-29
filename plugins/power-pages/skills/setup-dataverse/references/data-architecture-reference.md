# Data Architecture Reference

## Relationship Types

- **1:N (One-to-Many)**: Parent table referenced by child via Lookup. Parent must exist first.
- **N:N (Many-to-Many)**: Junction table created automatically. Both tables must exist first.
- **Self-Referential**: Table references itself. Table must exist before adding self-lookup.

## Dependency Tiers

Create tables in order by their dependencies:
- **Tier 0**: Reference/lookup tables (no dependencies) - Category, Status, Department
- **Tier 1**: Primary entities (reference Tier 0) - Product→Category, Employee→Department
- **Tier 2**: Dependent/transaction tables (reference Tier 1) - Order→Customer, OrderLine→Order
- **Tier 3**: Deeply nested tables (rare)

## Common Relationship Patterns

| Site Feature | Tables | Relationships |
|--------------|--------|---------------|
| **Blog** | Category, Author, BlogPost, Comment | Category(0) -> BlogPost(1) -> Comment(2); Author(0) -> BlogPost(1) |
| **E-commerce** | Category, Product, Customer, Order, OrderLine | Category(0) -> Product(1); Customer(1) -> Order(2) -> OrderLine(3) <- Product(1) |
| **Event Registration** | EventType, Event, Attendee, Registration | EventType(0) -> Event(1); Attendee(1) -> Registration(2) <- Event(1) |
| **Support Portal** | Category, Priority, Ticket, Comment | Category(0), Priority(0) -> Ticket(1) -> Comment(2) |
| **Directory/Listing** | Category, Location, Listing, Review | Category(0), Location(0) -> Listing(1) -> Review(2) |
| **Job Board** | Department, JobType, JobPosting, Application | Department(0), JobType(0) -> JobPosting(1) -> Application(2) |

## Validation Rules

Before table creation, validate:
1. No circular dependencies
2. All referenced tables exist
3. Lookup targets have primary keys
4. Self-references: create table first, then add self-lookup
