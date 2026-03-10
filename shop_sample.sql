-- ============================================================
-- NLSQL SAMPLE DATABASE: shop
-- A realistic e-commerce/retail shop schema with sample data.
--
-- Tables:
--   customers        - registered customers
--   categories       - product categories
--   products         - product catalogue
--   orders           - customer orders
--   order_items      - line items within each order
--   payments         - payment records per order
--   addresses        - customer shipping/billing addresses
--   reviews          - product reviews by customers
--
-- Usage:
--   mysql -u root -p < shop_sample.sql
-- ============================================================

DROP DATABASE IF EXISTS shop;
CREATE DATABASE shop
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE shop;

-- ============================================================
-- TABLE: customers
-- ============================================================
CREATE TABLE customers (
  id            INT          NOT NULL AUTO_INCREMENT,
  first_name    VARCHAR(100) NOT NULL COMMENT 'Customer first name',
  last_name     VARCHAR(100) NOT NULL COMMENT 'Customer last name',
  email         VARCHAR(255) NOT NULL COMMENT 'Unique login email address',
  phone         VARCHAR(20)           COMMENT 'Contact phone number',
  date_of_birth DATE                  COMMENT 'Used for birthday promotions',
  gender        ENUM('male','female','other','prefer_not_to_say') DEFAULT 'prefer_not_to_say',
  loyalty_tier  ENUM('bronze','silver','gold','platinum') NOT NULL DEFAULT 'bronze' COMMENT 'Loyalty programme tier',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1 = active account, 0 = deactivated',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Account registration date',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_email (email),
  INDEX idx_customers_loyalty_tier (loyalty_tier),
  INDEX idx_customers_created_at  (created_at)
) ENGINE=InnoDB COMMENT='Registered customer accounts';

INSERT INTO customers (first_name, last_name, email, phone, date_of_birth, gender, loyalty_tier, is_active, created_at) VALUES
('James',    'Mwangi',    'james.mwangi@email.com',    '+254712345001', '1990-03-15', 'male',   'gold',     1, '2022-01-10 08:30:00'),
('Aisha',    'Odhiambo',  'aisha.odhiambo@email.com',  '+254712345002', '1988-07-22', 'female', 'platinum', 1, '2021-11-05 14:20:00'),
('Brian',    'Kamau',     'brian.kamau@email.com',     '+254712345003', '1995-12-01', 'male',   'silver',   1, '2023-02-18 10:00:00'),
('Grace',    'Wanjiku',   'grace.wanjiku@email.com',   '+254712345004', '1992-05-30', 'female', 'gold',     1, '2022-06-25 09:45:00'),
('David',    'Otieno',    'david.otieno@email.com',    '+254712345005', '1985-09-14', 'male',   'bronze',   1, '2023-08-02 16:10:00'),
('Fatuma',   'Hassan',    'fatuma.hassan@email.com',   '+254712345006', '1993-01-08', 'female', 'silver',   1, '2022-12-14 11:30:00'),
('Peter',    'Njoroge',   'peter.njoroge@email.com',   '+254712345007', '1987-04-19', 'male',   'platinum', 1, '2021-07-30 08:00:00'),
('Lucy',     'Cherono',   'lucy.cherono@email.com',    '+254712345008', '1998-11-25', 'female', 'bronze',   1, '2024-01-15 13:20:00'),
('Samuel',   'Kipchoge',  'samuel.kipchoge@email.com', '+254712345009', '1991-06-03', 'male',   'gold',     1, '2022-03-08 07:50:00'),
('Mercy',    'Akinyi',    'mercy.akinyi@email.com',    '+254712345010', '1996-08-17', 'female', 'silver',   1, '2023-05-20 15:40:00'),
('John',     'Mutua',     'john.mutua@email.com',      '+254712345011', '1983-02-28', 'male',   'bronze',   0, '2022-09-11 10:15:00'),
('Caroline', 'Ndung\'u',  'caroline.ndungu@email.com', '+254712345012', '1994-10-12', 'female', 'gold',     1, '2022-04-03 12:00:00'),
('Kevin',    'Omondi',    'kevin.omondi@email.com',    '+254712345013', '1989-07-07', 'male',   'silver',   1, '2023-11-28 09:30:00'),
('Esther',   'Wambua',    'esther.wambua@email.com',   '+254712345014', '1997-03-22', 'female', 'bronze',   1, '2024-02-10 14:00:00'),
('Michael',  'Gitau',     'michael.gitau@email.com',   '+254712345015', '1986-12-05', 'male',   'platinum', 1, '2021-05-19 08:45:00');


-- ============================================================
-- TABLE: addresses
-- ============================================================
CREATE TABLE addresses (
  id            INT          NOT NULL AUTO_INCREMENT,
  customer_id   INT          NOT NULL,
  label         VARCHAR(50)  NOT NULL DEFAULT 'home' COMMENT 'e.g. home, work, other',
  address_line1 VARCHAR(255) NOT NULL,
  address_line2 VARCHAR(255),
  city          VARCHAR(100) NOT NULL,
  county        VARCHAR(100)           COMMENT 'County / region / state',
  postal_code   VARCHAR(20),
  country       VARCHAR(100) NOT NULL DEFAULT 'Kenya',
  is_default    TINYINT(1)   NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_addresses_customer_id (customer_id),
  CONSTRAINT fk_addresses_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Customer shipping and billing addresses';

INSERT INTO addresses (customer_id, label, address_line1, city, county, postal_code, country, is_default) VALUES
(1,  'home',   '14 Riverside Drive',     'Nairobi',  'Nairobi',     '00100', 'Kenya', 1),
(2,  'home',   '88 Kilimani Road',       'Nairobi',  'Nairobi',     '00200', 'Kenya', 1),
(2,  'work',   '3rd Floor, Westlands Sq','Nairobi',  'Nairobi',     '00600', 'Kenya', 0),
(3,  'home',   '5 Ngong Avenue',         'Nairobi',  'Nairobi',     '00300', 'Kenya', 1),
(4,  'home',   '21 Tom Mboya Street',    'Nairobi',  'Nairobi',     '00100', 'Kenya', 1),
(5,  'home',   '7 Kenyatta Avenue',      'Mombasa',  'Mombasa',     '80100', 'Kenya', 1),
(6,  'home',   '12 Nkrumah Road',        'Kisumu',   'Kisumu',      '40100', 'Kenya', 1),
(7,  'home',   '45 Oginga Odinga St',    'Kisumu',   'Kisumu',      '40100', 'Kenya', 1),
(7,  'work',   '2nd Floor, Lake Basin', 'Kisumu',   'Kisumu',      '40100', 'Kenya', 0),
(8,  'home',   '9 Uhuru Highway',        'Nakuru',   'Nakuru',      '20100', 'Kenya', 1),
(9,  'home',   '33 Barack Obama Road',   'Eldoret',  'Uasin Gishu', '30100', 'Kenya', 1),
(10, 'home',   '61 Moi Avenue',          'Nairobi',  'Nairobi',     '00100', 'Kenya', 1),
(11, 'home',   '17 Haile Selassie Ave',  'Nairobi',  'Nairobi',     '00200', 'Kenya', 1),
(12, 'home',   '2 Lenana Road',          'Nairobi',  'Nairobi',     '00100', 'Kenya', 1),
(13, 'home',   '8 Ronald Ngala Street',  'Nairobi',  'Nairobi',     '00100', 'Kenya', 1),
(14, 'home',   '19 Kimathi Street',      'Nairobi',  'Nairobi',     '00100', 'Kenya', 1),
(15, 'home',   '55 Waiyaki Way',         'Nairobi',  'Nairobi',     '00800', 'Kenya', 1),
(15, 'work',   '1 Upper Hill Close',     'Nairobi',  'Nairobi',     '00100', 'Kenya', 0);


-- ============================================================
-- TABLE: categories
-- ============================================================
CREATE TABLE categories (
  id          INT          NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL COMMENT 'Category display name',
  slug        VARCHAR(100) NOT NULL COMMENT 'URL-friendly name',
  parent_id   INT                   COMMENT 'NULL = top-level category',
  description TEXT,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_slug (slug),
  INDEX idx_categories_parent_id (parent_id),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Product category hierarchy';

INSERT INTO categories (id, name, slug, parent_id, description) VALUES
(1,  'Electronics',          'electronics',          NULL, 'Gadgets, devices, and electronic accessories'),
(2,  'Phones & Tablets',     'phones-tablets',       1,    'Smartphones, tablets, and accessories'),
(3,  'Laptops & Computers',  'laptops-computers',    1,    'Laptops, desktops, and peripherals'),
(4,  'Audio & Headphones',   'audio-headphones',     1,    'Headphones, speakers, and audio equipment'),
(5,  'Clothing',             'clothing',             NULL, 'Men, women, and children clothing'),
(6,  'Men\'s Wear',          'mens-wear',            5,    'Shirts, trousers, suits and more'),
(7,  'Women\'s Wear',        'womens-wear',          5,    'Dresses, blouses, skirts and more'),
(8,  'Home & Kitchen',       'home-kitchen',         NULL, 'Furniture, appliances, and kitchenware'),
(9,  'Kitchen Appliances',   'kitchen-appliances',   8,    'Blenders, microwaves, and cooking equipment'),
(10, 'Furniture',            'furniture',            8,    'Sofas, tables, beds, and storage'),
(11, 'Sports & Outdoors',    'sports-outdoors',      NULL, 'Fitness equipment, sportswear, and outdoor gear'),
(12, 'Fitness Equipment',    'fitness-equipment',    11,   'Weights, treadmills, yoga mats'),
(13, 'Books & Stationery',   'books-stationery',     NULL, 'Books, notebooks, pens, and office supplies');


-- ============================================================
-- TABLE: products
-- ============================================================
CREATE TABLE products (
  id             INT            NOT NULL AUTO_INCREMENT,
  category_id    INT            NOT NULL,
  name           VARCHAR(255)   NOT NULL COMMENT 'Product display name',
  sku            VARCHAR(100)   NOT NULL COMMENT 'Stock Keeping Unit — unique product code',
  description    TEXT           COMMENT 'Full product description',
  price          DECIMAL(10,2)  NOT NULL COMMENT 'Selling price in KES',
  cost_price     DECIMAL(10,2)  NOT NULL COMMENT 'Purchase/manufacturing cost in KES',
  stock_quantity INT            NOT NULL DEFAULT 0 COMMENT 'Units currently in stock',
  reorder_level  INT            NOT NULL DEFAULT 10 COMMENT 'Stock level that triggers a reorder',
  brand          VARCHAR(100)   COMMENT 'Product brand or manufacturer',
  weight_kg      DECIMAL(6,3)   COMMENT 'Shipping weight in kilograms',
  is_active      TINYINT(1)     NOT NULL DEFAULT 1 COMMENT '1 = available for sale',
  created_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku),
  INDEX idx_products_category_id (category_id),
  INDEX idx_products_price       (price),
  INDEX idx_products_is_active   (is_active),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB COMMENT='Product catalogue';

INSERT INTO products (category_id, name, sku, description, price, cost_price, stock_quantity, reorder_level, brand, weight_kg, is_active) VALUES
-- Phones & Tablets
(2,  'Samsung Galaxy S24',           'PHN-SAM-S24',    'Latest Samsung flagship smartphone, 256GB, 5G',        145000.00, 110000.00, 25,  5,  'Samsung',  0.167, 1),
(2,  'iPhone 15',                    'PHN-APL-IP15',   'Apple iPhone 15, 128GB, USB-C charging',               155000.00, 120000.00, 18,  5,  'Apple',    0.171, 1),
(2,  'Tecno Camon 20',               'PHN-TEC-C20',    'Affordable Tecno smartphone, 128GB, 64MP camera',       28000.00,  18000.00, 60,  15, 'Tecno',    0.195, 1),
(2,  'Samsung Galaxy Tab S9',        'TAB-SAM-S9',     'Samsung Android tablet, 10.9 inch, WiFi+LTE',           95000.00,  72000.00, 12,  5,  'Samsung',  0.498, 1),
(2,  'iPad 10th Generation',         'TAB-APL-IP10',   'Apple iPad 10th Gen, 64GB, WiFi',                       98000.00,  74000.00, 10,  5,  'Apple',    0.477, 1),
-- Laptops
(3,  'Dell Inspiron 15',             'LAP-DEL-IN15',   'Dell Inspiron 15, i5, 8GB RAM, 512GB SSD, Win11',       89000.00,  66000.00, 20,  5,  'Dell',     1.800, 1),
(3,  'HP Pavilion 14',               'LAP-HP-PAV14',   'HP Pavilion 14 inch, Ryzen 5, 8GB RAM, 256GB SSD',      75000.00,  56000.00, 15,  5,  'HP',       1.550, 1),
(3,  'MacBook Air M2',               'LAP-APL-MBA-M2', 'Apple MacBook Air M2, 8GB, 256GB, 13.6 inch',          175000.00, 140000.00,  8,  3,  'Apple',    1.240, 1),
(3,  'Logitech MX Keys Keyboard',    'ACC-LOG-MXK',    'Wireless backlit keyboard, multi-device',                9500.00,   6000.00, 40,  10, 'Logitech', 0.810, 1),
-- Audio
(4,  'Sony WH-1000XM5',             'AUD-SNY-XM5',    'Industry-leading noise cancelling over-ear headphones', 38000.00,  26000.00, 22,  8,  'Sony',     0.250, 1),
(4,  'JBL Flip 6',                  'AUD-JBL-FL6',    'Portable Bluetooth speaker, waterproof, 12hr battery',  12000.00,   8000.00, 35,  10, 'JBL',      0.550, 1),
(4,  'Apple AirPods Pro 2',         'AUD-APL-APP2',   'Active noise cancellation, MagSafe charging case',      32000.00,  23000.00, 20,  8,  'Apple',    0.061, 1),
-- Clothing — Men
(6,  'Classic Oxford Shirt (White)', 'CLO-MEN-OXF-W', 'Men\'s 100% cotton Oxford shirt, slim fit',              3200.00,   1400.00, 80,  20, 'FabriKen', 0.250, 1),
(6,  'Chino Trousers (Khaki)',       'CLO-MEN-CHN-K', 'Men\'s stretch chino, khaki, sizes 28–40',               4500.00,   2000.00, 60,  15, 'FabriKen', 0.450, 1),
(6,  'Slim Fit Blazer (Navy)',       'CLO-MEN-BLZ-N', 'Men\'s single-breasted blazer, polyester blend',        12000.00,   5500.00, 25,  8,  'FabriKen', 0.900, 1),
-- Clothing — Women
(7,  'Floral Wrap Dress',           'CLO-WMN-WRP-F', 'Women\'s midi wrap dress, floral print, sizes XS–XXL',   5500.00,   2200.00, 70,  20, 'FabriKen', 0.300, 1),
(7,  'High-Rise Jeans (Black)',      'CLO-WMN-JNS-B', 'Women\'s stretch denim, black, sizes 6–18',              4800.00,   2100.00, 55,  15, 'FabriKen', 0.550, 1),
-- Kitchen
(9,  'Blueflame Gas Cooker 3-Burner','KIT-BLF-GC3',  '3-burner tabletop gas cooker, stainless steel',         18500.00,  11000.00, 30,  8,  'Blueflame',7.500, 1),
(9,  'Nunix Table Blender',          'KIT-NNX-BL',   'Table blender 1.5L, 600W, stainless steel blades',       3800.00,   2000.00, 45,  15, 'Nunix',    1.200, 1),
(9,  'Ramtons Microwave 20L',        'KIT-RAM-MW20',  'Solo microwave 20L, 700W, 5 power levels',               9500.00,   6000.00, 20,  8,  'Ramtons',  9.500, 1),
-- Furniture
(10, 'L-Shape Sofa (Grey)',          'FRN-SOF-LGR',  '5-seater L-shape sofa, grey fabric, wooden legs',       85000.00,  52000.00,  5,  2,  'HomeDecor',38.000, 1),
(10, 'Office Chair (Ergonomic)',     'FRN-CHR-ERG',  'Ergonomic mesh office chair, lumbar support, adjustable',22000.00,  13000.00, 12,  4,  'HomeDecor', 9.500, 1),
-- Fitness
(12, 'Yoga Mat (6mm)',               'FIT-YGA-6MM',  'Non-slip TPE yoga mat, 6mm thick, 183x61cm',             2500.00,   1000.00, 100, 25, 'FitLife',   0.900, 1),
(12, 'Adjustable Dumbbell Set 20kg', 'FIT-DMB-20K',  'Adjustable dumbbell pair, 2x10kg, chrome handles',      18000.00,  10000.00, 15,  5,  'FitLife',  22.000, 1),
-- Books
(13, 'Rich Dad Poor Dad',            'BKS-RDP-RD',   'Robert Kiyosaki — personal finance bestseller',          1500.00,    700.00, 50,  15, 'Plata Pub', 0.350, 1),
(13, 'A5 Hardcover Notebook',        'STN-NTB-A5',   'A5 hardcover ruled notebook, 200 pages',                  550.00,    200.00,150,  40, 'Paperblanks',0.270, 1);


-- ============================================================
-- TABLE: orders
-- ============================================================
CREATE TABLE orders (
  id              INT            NOT NULL AUTO_INCREMENT,
  customer_id     INT            NOT NULL,
  address_id      INT            NOT NULL COMMENT 'Shipping address used for this order',
  status          ENUM('pending','confirmed','processing','shipped','delivered','cancelled','refunded')
                                 NOT NULL DEFAULT 'pending' COMMENT 'Current order status',
  subtotal        DECIMAL(12,2)  NOT NULL COMMENT 'Sum of all line items before discounts/tax',
  discount_amount DECIMAL(12,2)  NOT NULL DEFAULT 0.00 COMMENT 'Total discount applied to this order',
  tax_amount      DECIMAL(12,2)  NOT NULL DEFAULT 0.00 COMMENT 'VAT or other taxes',
  shipping_fee    DECIMAL(10,2)  NOT NULL DEFAULT 0.00,
  total_amount    DECIMAL(12,2)  NOT NULL COMMENT 'Final amount charged to customer',
  notes           TEXT           COMMENT 'Customer or internal notes on the order',
  ordered_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the order was placed',
  shipped_at      DATETIME                COMMENT 'When the order was dispatched',
  delivered_at    DATETIME                COMMENT 'When the order was received by customer',
  updated_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_orders_customer_id (customer_id),
  INDEX idx_orders_status      (status),
  INDEX idx_orders_ordered_at  (ordered_at),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_orders_address  FOREIGN KEY (address_id)  REFERENCES addresses(id)
) ENGINE=InnoDB COMMENT='Customer purchase orders';

INSERT INTO orders (customer_id, address_id, status, subtotal, discount_amount, tax_amount, shipping_fee, total_amount, ordered_at, shipped_at, delivered_at) VALUES
-- Delivered orders
(2,  2,  'delivered',  145000.00, 7250.00,  0.00,  0.00,  137750.00, '2025-10-05 09:15:00', '2025-10-06 11:00:00', '2025-10-08 14:30:00'),
(7,  7,  'delivered',   32000.00,    0.00,  0.00,  300.00,  32300.00, '2025-10-10 14:30:00', '2025-10-11 09:00:00', '2025-10-13 16:00:00'),
(1,  1,  'delivered',   38000.00, 1900.00,  0.00,  300.00,  36400.00, '2025-10-12 10:00:00', '2025-10-13 08:30:00', '2025-10-15 12:00:00'),
(15, 15, 'delivered',  175000.00, 8750.00,  0.00,  0.00,  166250.00, '2025-10-15 16:45:00', '2025-10-16 10:00:00', '2025-10-18 11:00:00'),
(9,  11, 'delivered',   12000.00,    0.00,  0.00,  300.00,  12300.00, '2025-10-18 08:00:00', '2025-10-19 09:30:00', '2025-10-21 15:00:00'),
(4,  5,  'delivered',   89000.00, 4450.00,  0.00,  300.00,  84850.00, '2025-10-20 11:30:00', '2025-10-21 08:00:00', '2025-10-23 14:00:00'),
(12, 14, 'delivered',    9700.00,    0.00,  0.00,  300.00,  10000.00, '2025-10-22 09:00:00', '2025-10-23 10:00:00', '2025-10-25 13:00:00'),
(2,  2,  'delivered',   95000.00, 4750.00,  0.00,  0.00,   90250.00, '2025-10-25 13:00:00', '2025-10-26 08:30:00', '2025-10-28 16:00:00'),
(3,  4,  'delivered',    8300.00,    0.00,  0.00,  300.00,   8600.00, '2025-11-01 10:15:00', '2025-11-02 09:00:00', '2025-11-04 14:00:00'),
(7,  7,  'delivered',  155000.00, 7750.00,  0.00,  0.00,  147250.00, '2025-11-03 15:00:00', '2025-11-04 10:30:00', '2025-11-06 12:00:00'),
(6,  7,  'delivered',   28000.00, 1400.00,  0.00,  300.00,  26900.00, '2025-11-05 08:30:00', '2025-11-06 09:00:00', '2025-11-08 15:00:00'),
(1,  1,  'delivered',   22000.00,    0.00,  0.00,  0.00,   22000.00, '2025-11-08 12:00:00', '2025-11-09 08:00:00', '2025-11-11 13:00:00'),
(15, 15, 'delivered',   38000.00, 1900.00,  0.00,  300.00,  36400.00, '2025-11-10 09:30:00', '2025-11-11 10:00:00', '2025-11-13 14:00:00'),
(10, 12, 'delivered',    5500.00,    0.00,  0.00,  300.00,   5800.00, '2025-11-12 14:00:00', '2025-11-13 09:00:00', '2025-11-15 11:00:00'),
(9,  11, 'delivered',   18500.00,    0.00,  0.00,  300.00,  18800.00, '2025-11-15 10:00:00', '2025-11-16 08:30:00', '2025-11-18 15:30:00'),
(4,  5,  'delivered',    3200.00,    0.00,  0.00,  300.00,   3500.00, '2025-11-18 11:00:00', '2025-11-19 09:00:00', '2025-11-21 14:00:00'),
(13, 15, 'delivered',   75000.00, 3750.00,  0.00,  300.00,  71550.00, '2025-11-20 08:00:00', '2025-11-21 10:00:00', '2025-11-23 13:00:00'),
(12, 14, 'delivered',   85000.00, 4250.00,  0.00,  0.00,   80750.00, '2025-11-22 13:00:00', '2025-11-23 09:30:00', '2025-11-25 15:00:00'),
(2,  2,  'delivered',   18000.00,    0.00,  0.00,  300.00,  18300.00, '2025-11-25 09:00:00', '2025-11-26 08:00:00', '2025-11-28 12:00:00'),
(5,  6,  'delivered',    4800.00,    0.00,  0.00,  300.00,   5100.00, '2025-11-28 14:00:00', '2025-11-29 09:30:00', '2025-12-01 14:00:00'),
-- December orders
(7,  7,  'delivered',   98000.00, 4900.00,  0.00,  0.00,   93100.00, '2025-12-01 10:00:00', '2025-12-02 09:00:00', '2025-12-04 14:00:00'),
(15, 15, 'delivered',   12000.00,    0.00,  0.00,  300.00,  12300.00, '2025-12-03 08:30:00', '2025-12-04 10:00:00', '2025-12-06 12:00:00'),
(1,  1,  'delivered',   28000.00, 1400.00,  0.00,  0.00,   26600.00, '2025-12-05 11:00:00', '2025-12-06 09:30:00', '2025-12-08 14:00:00'),
(9,  11, 'delivered',   32000.00,    0.00,  0.00,  300.00,  32300.00, '2025-12-07 14:00:00', '2025-12-08 08:00:00', '2025-12-10 13:00:00'),
(4,  5,  'delivered',  155000.00, 7750.00,  0.00,  0.00,  147250.00, '2025-12-09 09:00:00', '2025-12-10 10:00:00', '2025-12-12 15:00:00'),
(2,  2,  'delivered',    9500.00,    0.00,  0.00,  300.00,   9800.00, '2025-12-11 10:30:00', '2025-12-12 09:00:00', '2025-12-14 14:00:00'),
(12, 14, 'delivered',   38000.00, 1900.00,  0.00,  300.00,  36400.00, '2025-12-13 13:00:00', '2025-12-14 10:30:00', '2025-12-16 12:00:00'),
(6,  7,  'delivered',    2500.00,    0.00,  0.00,  300.00,   2800.00, '2025-12-15 08:00:00', '2025-12-16 09:00:00', '2025-12-18 11:00:00'),
(10, 12, 'delivered',   18000.00,    0.00,  0.00,  0.00,   18000.00, '2025-12-17 11:00:00', '2025-12-18 08:30:00', '2025-12-20 14:00:00'),
(3,  4,  'delivered',  145000.00, 7250.00,  0.00,  0.00,  137750.00, '2025-12-19 09:30:00', '2025-12-20 10:00:00', '2025-12-22 13:00:00'),
-- 2026 orders
(2,  2,  'delivered',   12000.00,    0.00,  0.00,  300.00,  12300.00, '2026-01-05 10:00:00', '2026-01-06 09:00:00', '2026-01-08 14:00:00'),
(7,  7,  'delivered',   89000.00, 4450.00,  0.00,  0.00,   84550.00, '2026-01-08 14:00:00', '2026-01-09 10:00:00', '2026-01-11 13:00:00'),
(15, 15, 'delivered',    9500.00,    0.00,  0.00,  300.00,  10000.00, '2026-01-10 09:00:00', '2026-01-11 09:30:00', '2026-01-13 15:00:00'),
(1,  1,  'delivered',   22000.00, 1100.00,  0.00,  300.00,  21200.00, '2026-01-12 11:00:00', '2026-01-13 08:00:00', '2026-01-15 12:00:00'),
(13, 15, 'delivered',   32000.00,    0.00,  0.00,  0.00,   32000.00, '2026-01-15 08:30:00', '2026-01-16 10:00:00', '2026-01-18 14:00:00'),
(9,  11, 'delivered',    3800.00,    0.00,  0.00,  300.00,   4100.00, '2026-01-18 13:00:00', '2026-01-19 09:00:00', '2026-01-21 11:00:00'),
(4,  5,  'delivered',   75000.00, 3750.00,  0.00,  0.00,   71250.00, '2026-01-20 10:00:00', '2026-01-21 08:30:00', '2026-01-23 14:00:00'),
(12, 14, 'delivered',    5500.00,    0.00,  0.00,  300.00,   5800.00, '2026-01-22 09:00:00', '2026-01-23 10:00:00', '2026-01-25 13:00:00'),
(6,  7,  'delivered',   18500.00,    0.00,  0.00,  300.00,  18800.00, '2026-01-25 14:00:00', '2026-01-26 09:00:00', '2026-01-28 15:00:00'),
(3,  4,  'delivered',    4800.00,    0.00,  0.00,  300.00,   5100.00, '2026-02-01 10:00:00', '2026-02-02 09:30:00', '2026-02-04 14:00:00'),
(2,  2,  'delivered',  155000.00, 7750.00,  0.00,  0.00,  147250.00, '2026-02-03 09:00:00', '2026-02-04 10:00:00', '2026-02-06 12:00:00'),
(15, 15, 'delivered',   28000.00, 1400.00,  0.00,  300.00,  26900.00, '2026-02-05 13:00:00', '2026-02-06 09:00:00', '2026-02-08 14:00:00'),
(1,  1,  'delivered',   12000.00,    0.00,  0.00,  300.00,  12300.00, '2026-02-08 08:00:00', '2026-02-09 10:00:00', '2026-02-11 13:00:00'),
(10, 12, 'delivered',   38000.00, 1900.00,  0.00,  0.00,   36100.00, '2026-02-10 11:00:00', '2026-02-11 09:00:00', '2026-02-13 15:00:00'),
(7,  7,  'delivered',    9500.00,    0.00,  0.00,  300.00,  10000.00, '2026-02-12 14:00:00', '2026-02-13 08:30:00', '2026-02-15 12:00:00'),
-- Recent orders — shipped / processing / pending
(5,  6,  'shipped',    145000.00, 7250.00,  0.00,  0.00,  137750.00, '2026-03-01 09:00:00', '2026-03-02 10:00:00', NULL),
(13, 15, 'shipped',     18000.00,    0.00,  0.00,  300.00,  18300.00, '2026-03-02 14:00:00', '2026-03-03 09:30:00', NULL),
(8,  10, 'processing',  32000.00,    0.00,  0.00,  300.00,  32300.00, '2026-03-04 10:30:00', NULL,                   NULL),
(14, 17, 'processing',   9500.00,    0.00,  0.00,  300.00,   9800.00, '2026-03-05 08:00:00', NULL,                   NULL),
(3,  4,  'confirmed',   89000.00, 4450.00,  0.00,  0.00,   84550.00, '2026-03-06 11:00:00', NULL,                   NULL),
(10, 12, 'confirmed',    3200.00,    0.00,  0.00,  300.00,   3500.00, '2026-03-07 09:00:00', NULL,                   NULL),
(6,  7,  'pending',     75000.00,    0.00,  0.00,  0.00,   75000.00, '2026-03-08 14:30:00', NULL,                   NULL),
(14, 17, 'pending',      2500.00,    0.00,  0.00,  300.00,   2800.00, '2026-03-09 08:00:00', NULL,                   NULL),
-- Cancelled & refunded
(11, 13, 'cancelled',   38000.00,    0.00,  0.00,  300.00,  38300.00, '2025-12-20 10:00:00', NULL,                   NULL),
(5,  6,  'refunded',    12000.00,    0.00,  0.00,  300.00,  12300.00, '2026-01-30 09:00:00', '2026-01-31 10:00:00', '2026-02-02 14:00:00');


-- ============================================================
-- TABLE: order_items
-- ============================================================
CREATE TABLE order_items (
  id          INT           NOT NULL AUTO_INCREMENT,
  order_id    INT           NOT NULL,
  product_id  INT           NOT NULL,
  quantity    INT           NOT NULL DEFAULT 1,
  unit_price  DECIMAL(10,2) NOT NULL COMMENT 'Price at time of purchase (may differ from current price)',
  total_price DECIMAL(12,2) NOT NULL COMMENT 'quantity x unit_price',
  PRIMARY KEY (id),
  INDEX idx_order_items_order_id   (order_id),
  INDEX idx_order_items_product_id (product_id),
  CONSTRAINT fk_order_items_order   FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB COMMENT='Individual line items belonging to an order';

INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price) VALUES
-- Order 1 (customer 2, delivered)
(1,  1,  1, 145000.00, 145000.00),
-- Order 2 (customer 7)
(2,  12, 1,  32000.00,  32000.00),
-- Order 3 (customer 1)
(3,  10, 1,  38000.00,  38000.00),
-- Order 4 (customer 15)
(4,  8,  1, 175000.00, 175000.00),
-- Order 5 (customer 9)
(5,  11, 1,  12000.00,  12000.00),
-- Order 6 (customer 4)
(6,  6,  1,  89000.00,  89000.00),
-- Order 7 (customer 12)
(7,  9,  1,   9500.00,   9500.00),
(7,  26, 1,     200.00,    200.00),
-- Order 8 (customer 2)
(8,  4,  1,  95000.00,  95000.00),
-- Order 9 (customer 3)
(9,  13, 1,   3200.00,   3200.00),
(9,  14, 1,   4500.00,   4500.00),
(9,  26, 2,     275.00,    550.00),
-- Order 10 (customer 7)
(10, 2,  1, 155000.00, 155000.00),
-- Order 11 (customer 6)
(11, 3,  1,  28000.00,  28000.00),
-- Order 12 (customer 1)
(12, 22, 1,  22000.00,  22000.00),
-- Order 13 (customer 15)
(13, 10, 1,  38000.00,  38000.00),
-- Order 14 (customer 10)
(14, 16, 1,   5500.00,   5500.00),
-- Order 15 (customer 9)
(15, 18, 1,  18500.00,  18500.00),
-- Order 16 (customer 4)
(16, 13, 1,   3200.00,   3200.00),
-- Order 17 (customer 13)
(17, 7,  1,  75000.00,  75000.00),
-- Order 18 (customer 12)
(18, 21, 1,  85000.00,  85000.00),
-- Order 19 (customer 2)
(19, 19, 1,  18000.00,  18000.00),   -- Nunix blender
-- Order 20 (customer 5)
(20, 17, 1,   4800.00,   4800.00),
-- Order 21 (customer 7)
(21, 5,  1,  98000.00,  98000.00),
-- Order 22 (customer 15)
(22, 11, 1,  12000.00,  12000.00),
-- Order 23 (customer 1)
(23, 3,  1,  28000.00,  28000.00),
-- Order 24 (customer 9)
(24, 12, 1,  32000.00,  32000.00),
-- Order 25 (customer 4)
(25, 2,  1, 155000.00, 155000.00),
-- Order 26 (customer 2)
(26, 20, 1,   9500.00,   9500.00),
-- Order 27 (customer 12)
(27, 10, 1,  38000.00,  38000.00),
-- Order 28 (customer 6)
(28, 23, 1,   2500.00,   2500.00),
-- Order 29 (customer 10)
(29, 19, 1,  18000.00,  18000.00),   -- typo corrected: was 18500 in order
-- Order 30 (customer 3)
(30, 1,  1, 145000.00, 145000.00),
-- 2026 orders
(31, 11, 1,  12000.00,  12000.00),
(32, 6,  1,  89000.00,  89000.00),
(33, 20, 1,   9500.00,   9500.00),
(34, 22, 1,  22000.00,  22000.00),
(35, 12, 1,  32000.00,  32000.00),
(36, 19, 1,   3800.00,   3800.00),
(37, 7,  1,  75000.00,  75000.00),
(38, 16, 1,   5500.00,   5500.00),
(39, 18, 1,  18500.00,  18500.00),
(40, 17, 1,   4800.00,   4800.00),
(41, 2,  1, 155000.00, 155000.00),
(42, 3,  1,  28000.00,  28000.00),
(43, 11, 1,  12000.00,  12000.00),
(44, 10, 1,  38000.00,  38000.00),
(45, 20, 1,   9500.00,   9500.00),
-- shipped/processing/pending
(46, 1,  1, 145000.00, 145000.00),
(47, 18, 1,  18000.00,  18000.00),
(48, 12, 1,  32000.00,  32000.00),
(49, 20, 1,   9500.00,   9500.00),
(50, 6,  1,  89000.00,  89000.00),
(51, 13, 1,   3200.00,   3200.00),
(52, 21, 1,  75000.00,  75000.00),
(53, 23, 1,   2500.00,   2500.00),
-- cancelled & refunded
(54, 10, 1,  38000.00,  38000.00),
(55, 11, 1,  12000.00,  12000.00);


-- ============================================================
-- TABLE: payments
-- ============================================================
CREATE TABLE payments (
  id             INT           NOT NULL AUTO_INCREMENT,
  order_id       INT           NOT NULL,
  method         ENUM('mpesa','card','bank_transfer','cash_on_delivery') NOT NULL COMMENT 'Payment method used',
  status         ENUM('pending','completed','failed','refunded') NOT NULL DEFAULT 'pending',
  amount         DECIMAL(12,2) NOT NULL,
  transaction_ref VARCHAR(100)  COMMENT 'External payment reference (e.g. M-Pesa transaction code)',
  paid_at        DATETIME               COMMENT 'When the payment was confirmed',
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_payments_order_id (order_id),
  INDEX idx_payments_status   (status),
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Payment records for orders';

INSERT INTO payments (order_id, method, status, amount, transaction_ref, paid_at) VALUES
(1,  'mpesa',           'completed', 137750.00, 'QJZ1A2BC3D', '2025-10-05 09:20:00'),
(2,  'card',            'completed',  32300.00, 'TXN-4421001', '2025-10-10 14:35:00'),
(3,  'mpesa',           'completed',  36400.00, 'QJZ4E5FG6H', '2025-10-12 10:05:00'),
(4,  'bank_transfer',   'completed', 166250.00, 'KCBREF20251015', '2025-10-15 17:00:00'),
(5,  'mpesa',           'completed',  12300.00, 'QJZ7I8JK9L', '2025-10-18 08:05:00'),
(6,  'card',            'completed',  84850.00, 'TXN-4421002', '2025-10-20 11:35:00'),
(7,  'mpesa',           'completed',  10000.00, 'QJZ0M1NO2P', '2025-10-22 09:05:00'),
(8,  'bank_transfer',   'completed',  90250.00, 'KCBREF20251025', '2025-10-25 13:30:00'),
(9,  'cash_on_delivery','completed',   8600.00, NULL,            '2025-11-04 14:30:00'),
(10, 'mpesa',           'completed', 147250.00, 'QJZ3Q4RS5T', '2025-11-03 15:05:00'),
(11, 'mpesa',           'completed',  26900.00, 'QJZ6U7VW8X', '2025-11-05 08:35:00'),
(12, 'card',            'completed',  22000.00, 'TXN-4421003', '2025-11-08 12:05:00'),
(13, 'mpesa',           'completed',  36400.00, 'QJZ9Y0ZA1B', '2025-11-10 09:35:00'),
(14, 'cash_on_delivery','completed',   5800.00, NULL,            '2025-11-15 11:00:00'),
(15, 'mpesa',           'completed',  18800.00, 'QJZ2C3DE4F', '2025-11-15 10:05:00'),
(16, 'cash_on_delivery','completed',   3500.00, NULL,            '2025-11-21 14:00:00'),
(17, 'card',            'completed',  71550.00, 'TXN-4421004', '2025-11-20 08:05:00'),
(18, 'bank_transfer',   'completed',  80750.00, 'KCBREF20251122', '2025-11-22 14:00:00'),
(19, 'mpesa',           'completed',  18300.00, 'QJZ5G6HI7J', '2025-11-25 09:05:00'),
(20, 'cash_on_delivery','completed',   5100.00, NULL,            '2025-12-01 14:00:00'),
(21, 'mpesa',           'completed',  93100.00, 'QJZ8K9LM0N', '2025-12-01 10:05:00'),
(22, 'mpesa',           'completed',  12300.00, 'QJZ1O2PQ3R', '2025-12-03 08:35:00'),
(23, 'mpesa',           'completed',  26600.00, 'QJZ4S5TU6V', '2025-12-05 11:05:00'),
(24, 'card',            'completed',  32300.00, 'TXN-4421005', '2025-12-07 14:05:00'),
(25, 'bank_transfer',   'completed', 147250.00, 'KCBREF20251209', '2025-12-09 09:30:00'),
(26, 'mpesa',           'completed',   9800.00, 'QJZ7W8XY9Z', '2025-12-11 10:35:00'),
(27, 'mpesa',           'completed',  36400.00, 'QJZ0A1BC2D', '2025-12-13 13:05:00'),
(28, 'cash_on_delivery','completed',   2800.00, NULL,            '2025-12-18 11:00:00'),
(29, 'card',            'completed',  18000.00, 'TXN-4421006', '2025-12-17 11:05:00'),
(30, 'mpesa',           'completed', 137750.00, 'QJZ3E4FG5H', '2025-12-19 09:35:00'),
(31, 'mpesa',           'completed',  12300.00, 'QJZ6I7JK8L', '2026-01-05 10:05:00'),
(32, 'card',            'completed',  84550.00, 'TXN-4421007', '2026-01-08 14:05:00'),
(33, 'mpesa',           'completed',  10000.00, 'QJZ9M0NO1P', '2026-01-10 09:05:00'),
(34, 'mpesa',           'completed',  21200.00, 'QJZ2Q3RS4T', '2026-01-12 11:05:00'),
(35, 'card',            'completed',  32000.00, 'TXN-4421008', '2026-01-15 08:35:00'),
(36, 'cash_on_delivery','completed',   4100.00, NULL,            '2026-01-21 11:00:00'),
(37, 'bank_transfer',   'completed',  71250.00, 'KCBREF20260120', '2026-01-20 10:30:00'),
(38, 'cash_on_delivery','completed',   5800.00, NULL,            '2026-01-25 13:00:00'),
(39, 'mpesa',           'completed',  18800.00, 'QJZ5U6VW7X', '2026-01-25 14:05:00'),
(40, 'cash_on_delivery','completed',   5100.00, NULL,            '2026-02-04 14:00:00'),
(41, 'mpesa',           'completed', 147250.00, 'QJZ8Y9ZA0B', '2026-02-03 09:05:00'),
(42, 'mpesa',           'completed',  26900.00, 'QJZ1C2DE3F', '2026-02-05 13:05:00'),
(43, 'mpesa',           'completed',  12300.00, 'QJZ4G5HI6J', '2026-02-08 08:05:00'),
(44, 'card',            'completed',  36100.00, 'TXN-4421009', '2026-02-10 11:05:00'),
(45, 'mpesa',           'completed',  10000.00, 'QJZ7K8LM9N', '2026-02-12 14:05:00'),
(46, 'mpesa',           'pending',   137750.00, 'QJZ0O1PQ2R', NULL),
(47, 'mpesa',           'completed',  18300.00, 'QJZ3S4TU5V', '2026-03-02 14:05:00'),
(48, 'card',            'pending',    32300.00, NULL,            NULL),
(49, 'mpesa',           'pending',     9800.00, NULL,            NULL),
(50, 'bank_transfer',   'pending',    84550.00, NULL,            NULL),
(51, 'cash_on_delivery','pending',     3500.00, NULL,            NULL),
(52, 'mpesa',           'pending',    75000.00, NULL,            NULL),
(53, 'cash_on_delivery','pending',     2800.00, NULL,            NULL),
(54, 'card',            'failed',     38300.00, 'TXN-FAIL-001',  NULL),
(55, 'mpesa',           'refunded',   12300.00, 'QJZ6W7XY8Z',  '2026-01-31 10:05:00');


-- ============================================================
-- TABLE: reviews
-- ============================================================
CREATE TABLE reviews (
  id          INT       NOT NULL AUTO_INCREMENT,
  product_id  INT       NOT NULL,
  customer_id INT       NOT NULL,
  rating      TINYINT   NOT NULL COMMENT 'Score from 1 (worst) to 5 (best)',
  title       VARCHAR(255),
  body        TEXT,
  is_verified TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = confirmed purchase by this customer',
  created_at  DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_reviews_product_id  (product_id),
  INDEX idx_reviews_customer_id (customer_id),
  CONSTRAINT fk_reviews_product  FOREIGN KEY (product_id)  REFERENCES products(id),
  CONSTRAINT fk_reviews_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT chk_reviews_rating  CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB COMMENT='Customer product reviews and ratings';

INSERT INTO reviews (product_id, customer_id, rating, title, body, is_verified) VALUES
(1,  2,  5, 'Absolutely love it!',         'The Samsung S24 camera is incredible. Very fast and battery lasts all day.', 1),
(2,  7,  5, 'iPhone 15 worth every penny', 'USB-C is finally here. Photos are stunning. Build quality is top notch.',   1),
(3,  6,  4, 'Great budget phone',          'For the price, the Tecno Camon 20 is unbeatable. Camera could be better indoors.', 1),
(6,  4,  5, 'Solid laptop for work',       'Dell Inspiron handles everything I throw at it. Battery life is decent.',   1),
(7,  13, 4, 'Good HP Pavilion',            'Fast for everyday tasks. Fan gets a bit loud under load.',                  1),
(8,  15, 5, 'MacBook Air M2 is a beast',   'Silent, fast, and the display is gorgeous. Best laptop I have owned.',      1),
(10, 1,  5, 'Best headphones ever',        'The noise cancellation on the Sony XM5 is on another level. Worth it.',    1),
(10, 9,  4, 'Great but pricey',            'Sound quality is amazing. Wish they were a bit cheaper here in Kenya.',    1),
(11, 12, 5, 'JBL Flip 6 is perfect',       'Waterproof, loud, and the battery lasts forever. Great for the beach.',    1),
(12, 2,  5, 'AirPods Pro 2 excellence',    'Seamless with my iPhone. ANC is fantastic for matatu rides.',              1),
(13, 3,  5, 'Love the Oxford shirt',       'Great quality fabric, fits perfectly, iron stays out.',                    1),
(16, 10, 4, 'Nice wrap dress',             'Lovely floral print. Runs slightly large so order one size down.',         1),
(18, 9,  4, 'Good gas cooker',             'Heats up quickly and very easy to clean. Solid build.',                    1),
(22, 12, 5, 'Ergonomic chair changed my life', 'My back pain is gone since I started using this chair. Highly recommend.', 1),
(23, 6,  5, 'Best yoga mat',               'Non-slip surface is excellent even when sweaty. Great thickness.',         1),
(25, 4,  5, 'Must read!',                  'Rich Dad Poor Dad changed my perspective on money. Everyone should read this.', 0),
(1,  7,  4, 'Very good Samsung',           'Slightly expensive but worth it. Camera and speed are top.',               0),
(8,  1,  5, 'MacBook M2 is incredible',   'Best purchase I have made this year. The battery life alone is worth it.',  1);


-- ============================================================
-- SUMMARY VIEW (optional convenience view)
-- ============================================================
CREATE OR REPLACE VIEW v_order_summary AS
SELECT
  o.id                                          AS order_id,
  CONCAT(c.first_name, ' ', c.last_name)        AS customer_name,
  c.email                                        AS customer_email,
  c.loyalty_tier,
  o.status                                       AS order_status,
  o.total_amount,
  p.method                                       AS payment_method,
  p.status                                       AS payment_status,
  o.ordered_at,
  o.delivered_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN payments p ON p.order_id = o.id;

-- ============================================================
-- Done!
-- ============================================================
SELECT 'Database "shop" created successfully.' AS message;
SELECT CONCAT(COUNT(*), ' customers') AS summary FROM customers
UNION ALL SELECT CONCAT(COUNT(*), ' products')  FROM products
UNION ALL SELECT CONCAT(COUNT(*), ' orders')    FROM orders
UNION ALL SELECT CONCAT(COUNT(*), ' payments')  FROM payments
UNION ALL SELECT CONCAT(COUNT(*), ' reviews')   FROM reviews;
