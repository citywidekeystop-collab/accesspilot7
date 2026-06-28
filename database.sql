CREATE TABLE users (
id INT AUTO_INCREMENT PRIMARY KEY,
name VARCHAR(100) NOT NULL,
email VARCHAR(150) NOT NULL UNIQUE,
password_hash VARCHAR(255) NOT NULL,
role ENUM('super_admin','hoa_admin','manager','security','resident') DEFAULT 'hoa_admin',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE properties (
id INT AUTO_INCREMENT PRIMARY KEY,
name VARCHAR(150) NOT NULL,
address VARCHAR(255) NOT NULL,
city VARCHAR(100),
state VARCHAR(50),
zip VARCHAR(20),
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE residents (
id INT AUTO_INCREMENT PRIMARY KEY,
property_id INT NOT NULL,
name VARCHAR(120) NOT NULL,
unit VARCHAR(50) NOT NULL,
phone VARCHAR(40),
email VARCHAR(150),
status ENUM('active','disabled') DEFAULT 'active',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
FOREIGN KEY (property_id) REFERENCES properties(id)
);

CREATE TABLE fobs (
id INT AUTO_INCREMENT PRIMARY KEY,
resident_id INT NOT NULL,
fob_id VARCHAR(100) NOT NULL UNIQUE,
status ENUM('active','disabled','lost') DEFAULT 'active',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
FOREIGN KEY (resident_id) REFERENCES residents(id)
);

CREATE TABLE doors (
id INT AUTO_INCREMENT PRIMARY KEY,
property_id INT NOT NULL,
name VARCHAR(120) NOT NULL,
status ENUM('online','offline','locked','unlocked') DEFAULT 'online',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
FOREIGN KEY (property_id) REFERENCES properties(id)
);

CREATE TABLE audit_logs (
id INT AUTO_INCREMENT PRIMARY KEY,
property_id INT,
resident_id INT,
fob_id VARCHAR(100),
door_id INT,
action VARCHAR(100) NOT NULL,
result VARCHAR(50) NOT NULL,
notes TEXT,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
