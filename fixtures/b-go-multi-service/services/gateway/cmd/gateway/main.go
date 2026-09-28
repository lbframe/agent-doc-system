package main

import (
	"database/sql"

	_ "github.com/lib/pq"
	"example.com/ledger/libs/protocol"
)

// Gateway serves the ledger read API and owns the ledger database.
func main() {
	_ = protocol.LedgerService_ServiceDesc
	_, _ = sql.Open("postgres", "")
}
