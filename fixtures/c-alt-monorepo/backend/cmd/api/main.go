package main

import (
	"database/sql"
	"net/http"

	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"
)

const healthz = "/healthz"

func main() {
	_, _ = sql.Open("postgres", "")
	_ = redis.NewClient(&redis.Options{})
	_ = http.ListenAndServe(":8081", nil)
}
