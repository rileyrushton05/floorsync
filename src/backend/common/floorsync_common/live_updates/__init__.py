"""Tell every open dashboard that a simulation changed (#148).

The durable authority stays the simulation event log. What lives here is the durable half of the
notification: a versioned envelope describing one change, and the outbox row that records it in the
same transaction as the change so a lost Redis message can be replayed. Nothing here talks to Redis
or holds a socket; that is the API's job.

`contracts` is pure and safe to import anywhere. `service` needs the database.
"""
