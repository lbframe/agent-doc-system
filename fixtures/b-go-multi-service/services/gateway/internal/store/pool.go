package store

import "database/sql"

func Open() (*sql.DB, error) { return sql.Open("postgres", "") }
