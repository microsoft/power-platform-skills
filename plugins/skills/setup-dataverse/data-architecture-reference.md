# Data Architecture Reference

This document covers data architecture principles for designing Dataverse table schemas for Power Pages sites.

## Entity-Relationship Analysis

Identify all entities and their relationships before creating any tables:

```text
RELATIONSHIP TYPES IN DATAVERSE

1:N (One-to-Many) - Most common
  - Parent table referenced by child table via Lookup column
  - Example: Category (1) -> Products (N)
  - Parent must exist before child can reference it

N:N (Many-to-Many)
  - Junction/intersection table created automatically
  - Example: Products <-> Tags
  - Both tables must exist before creating the relationship

Self-Referential
  - Table references itself
  - Example: Employee -> Manager (also an Employee)
  - Table must exist before adding self-referential lookup

Polymorphic (Customer/Regarding)
  - Single column can reference multiple table types
  - Example: Activity regarding Contact OR Account OR Lead
  - All target tables must exist before creating polymorphic lookup
```

## Table Classification

Classify tables into tiers based on their dependencies:

```text
TABLE DEPENDENCY TIERS

TIER 0: Reference/Lookup Tables (Create FIRST)
  - No foreign keys to other custom tables
  - Examples: Category, Status, Country, Department, Tag
  - These are the "dictionaries" of your data model

TIER 1: Primary Entity Tables (Create SECOND)
  - Only reference Tier 0 tables or system tables
  - Examples: Product (->Category), Employee (->Department)
  - Core business entities

TIER 2: Dependent/Transaction Tables (Create THIRD)
  - Reference Tier 1 tables
  - Examples: Order (->Customer), OrderLine (->Order, ->Product)
  - Often transactional or junction tables

TIER 3: Deeply Nested Tables (Create LAST)
  - Reference Tier 2 tables
  - Examples: OrderLineDetail (->OrderLine), PaymentAllocation (->Payment)
  - Rare in typical Power Pages sites
```

## Dependency Graph Documentation

**Always document the dependency graph before creating tables:**

```text
Example: E-Commerce Site Data Architecture

                    +-------------+
                    |  Category   |  TIER 0
                    |  (lookup)   |
                    +------+------+
                           |
           +---------------+---------------+
           v               v               v
    +--------------+ +--------------+ +--------------+
    |   Product    | |   Supplier   | |   Customer   |  TIER 1
    | (->Category) | |              | |              |
    +------+-------+ +------+-------+ +------+-------+
           |               |               |
           +---------------+---------------+
                           v
                    +--------------+
                    |    Order     |  TIER 2
                    | (->Customer) |
                    +------+-------+
                           |
                           v
                    +--------------+
                    |  OrderLine   |  TIER 3
                    |(->Order,     |
                    | ->Product)   |
                    +--------------+

Creation Order: Category -> Product, Supplier, Customer -> Order -> OrderLine
```

## Common Relationship Patterns for Power Pages Sites

| Site Feature | Tables | Relationships |
|--------------|--------|---------------|
| **Blog** | Category, Author, BlogPost, Comment | Category(0) -> BlogPost(1) -> Comment(2); Author(0) -> BlogPost(1) |
| **E-commerce** | Category, Product, Customer, Order, OrderLine | Category(0) -> Product(1); Customer(1) -> Order(2) -> OrderLine(3) <- Product(1) |
| **Event Registration** | EventType, Event, Attendee, Registration | EventType(0) -> Event(1); Attendee(1) -> Registration(2) <- Event(1) |
| **Support Portal** | Category, Priority, Ticket, Comment | Category(0), Priority(0) -> Ticket(1) -> Comment(2) |
| **Directory/Listing** | Category, Location, Listing, Review | Category(0), Location(0) -> Listing(1) -> Review(2) |
| **Job Board** | Department, JobType, JobPosting, Application | Department(0), JobType(0) -> JobPosting(1) -> Application(2) |

## Dependency Analysis Algorithm

```text
1. List all tables and their lookup columns
2. Build adjacency list: for each table, list tables it depends on
3. Perform topological sort to get valid creation order
4. If cycle detected, report error (invalid schema design)
5. Group tables by tier for parallel creation where possible
```

### Example Dependency Resolution

```powershell
# Example: Building dependency graph in PowerShell
$tables = @{
    "cr_category" = @()                           # No dependencies - TIER 0
    "cr_status" = @()                             # No dependencies - TIER 0
    "cr_department" = @()                         # No dependencies - TIER 0
    "cr_product" = @("cr_category")               # Depends on category - TIER 1
    "cr_teammember" = @("cr_department")          # Depends on department - TIER 1
    "cr_testimonial" = @("cr_product")            # Depends on product - TIER 2
    "cr_contactsubmission" = @("cr_status")       # Depends on status - TIER 1
}

# Topological sort result (creation order):
# 1. cr_category, cr_status, cr_department (can be parallel)
# 2. cr_product, cr_teammember, cr_contactsubmission (after their deps)
# 3. cr_testimonial (after cr_product)
```

## Validation Rules

Before proceeding to table creation, validate:

1. **No circular dependencies** - A cannot depend on B if B depends on A
2. **All referenced tables exist** - Either in schema or as system tables
3. **Lookup targets are valid** - Table being referenced must have a primary key
4. **Self-references are handled** - Table created first, then self-lookup added

## Example Analysis Output Format

```text
DATA ARCHITECTURE FOR: [Site Name]

TIER 0 - Reference Tables (No Dependencies)
  1. cr_category        - Product/content categories
  2. cr_status          - Status values for various entities
  3. cr_department      - Team member departments

TIER 1 - Primary Entity Tables
  4. cr_product         - Products (-> cr_category)
  5. cr_teammember      - Team members (-> cr_department)
  6. cr_blogpost        - Blog posts (-> cr_category)

TIER 2 - Dependent Tables
  7. cr_testimonial     - Testimonials (-> cr_product, optional)
  8. cr_contactsubmission - Contact submissions (-> cr_status)

RELATIONSHIP DIAGRAM

  cr_category --+---> cr_product ---> cr_testimonial
                +---> cr_blogpost

  cr_department ---> cr_teammember

  cr_status -------> cr_contactsubmission

CREATION ORDER
  1. cr_category, cr_status, cr_department (parallel - no deps)
  2. cr_product, cr_teammember, cr_blogpost (after tier 0)
  3. cr_testimonial, cr_contactsubmission (after their references)
```
