CREATE TABLE customers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name text NOT NULL,
  email text NOT NULL UNIQUE,
  city text NOT NULL
);

CREATE TABLE products (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price numeric(10, 2) NOT NULL CHECK (price >= 0),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

CREATE TABLE orders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  status text NOT NULL CHECK (status IN ('processing', 'shipped', 'delivered')),
  created_at timestamptz NOT NULL DEFAULT now(),
  total numeric(10, 2) NOT NULL CHECK (total >= 0)
);

CREATE TABLE order_items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products (id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(10, 2) NOT NULL CHECK (unit_price >= 0),
  UNIQUE (order_id, product_id)
);

INSERT INTO customers (full_name, email, city) VALUES
  ('Avery Chen', 'avery@example.test', 'Seattle'),
  ('Jordan Patel', 'jordan@example.test', 'Austin'),
  ('Morgan Rivera', 'morgan@example.test', 'Toronto'),
  ('Sam Okafor', 'sam@example.test', 'London'),
  ('Taylor Kim', 'taylor@example.test', 'Seoul');

INSERT INTO products (name, category, price, stock) VALUES
  ('Field Notes', 'Stationery', 12.00, 84),
  ('Desk Lamp', 'Workspace', 68.50, 22),
  ('Ceramic Mug', 'Kitchen', 24.00, 47),
  ('Canvas Tote', 'Accessories', 19.50, 63),
  ('Mechanical Pencil', 'Stationery', 8.75, 105),
  ('Monitor Stand', 'Workspace', 54.00, 15);

INSERT INTO orders (customer_id, status, created_at, total) VALUES
  (1, 'delivered', '2026-09-28 10:15:00+00', 44.00),
  (2, 'shipped', '2026-10-02 14:30:00+00', 68.50),
  (1, 'processing', '2026-10-08 09:05:00+00', 37.00),
  (3, 'delivered', '2026-10-10 16:40:00+00', 73.50),
  (4, 'processing', '2026-10-14 11:20:00+00', 54.00),
  (5, 'shipped', '2026-10-15 08:10:00+00', 21.75);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 12.00), (1, 3, 1, 24.00), (1, 5, 1, 8.00),
  (2, 2, 1, 68.50),
  (3, 4, 1, 19.50), (3, 5, 2, 8.75),
  (4, 2, 1, 68.50), (4, 1, 1, 5.00),
  (5, 6, 1, 54.00),
  (6, 5, 1, 8.75), (6, 4, 1, 13.00);
