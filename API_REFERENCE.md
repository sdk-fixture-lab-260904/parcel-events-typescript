# @sdkfixturelab260904/parcel-events-sdk — API reference

18 methods across 6 top-level resources. Every method returns an `APIPromise` (`await` it, or `.withResponse()` / `.asResponse()`); paginated methods return a page you can `for await`. Types are exported from the package root.

## `client.labels`

- `client.labels.create(body, params, options?)` → `Label` — `POST /v1/labels`
- `client.labels.retrieve(labelID, options?)` → `Label` — `GET /v1/labels/{label_id}`

```ts
const result = await client.labels.create({
  format: "pdf",
  page_size: "four_by_six",
  shipment_id: "shp_00000000000000000001"
}, {
  idempotencyKey: "string"
});
console.log(result);
```

## `client.pickups`

- `client.pickups.cancel(pickupID, options?)` → `void` — `DELETE /v1/pickups/{pickup_id}`
- `client.pickups.create(body, params, options?)` → `Pickup` — `POST /v1/pickups`
- `client.pickups.list(params?, options?)` → `Page<PickupPage>` — `GET /v1/pickups`
- `client.pickups.retrieve(pickupID, options?)` → `Pickup` — `GET /v1/pickups/{pickup_id}`

```ts
await client.pickups.cancel("string");
```

## `client.rates`

- `client.rates.quote(body, options?)` → `RatesQuoteResponse` — `POST /v1/rates/quote`

```ts
const result = await client.rates.quote({
  parcels: [
    {
      contents: [
        {
          customs_code: "610910",
          description: "Synthetic cotton shirt",
          quantity: 2,
          unit_value: {
            amount: "12.50",
            currency: "XTS"
          }
        }
      ],
      height_cm: 12,
      length_cm: 30.5,
      weight_grams: 1750,
      width_cm: 20
    }
  ],
  recipient: {
    city: "Exampleton",
    company: "Northstar Supplies",
    country: "ZZ",
    line1: "14 Fictional Quay",
    line2: "Unit 7",
    name: "Rowan Example",
    phone: "+00000000000",
    postal_code: "EX4 2PL",
    region: "Test Province"
  },
  sender: {
    city: "Exampleton",
    company: "Northstar Supplies",
    country: "ZZ",
    line1: "14 Fictional Quay",
    line2: "Unit 7",
    name: "Rowan Example",
    phone: "+00000000000",
    postal_code: "EX4 2PL",
    region: "Test Province"
  }
});
console.log(result);
```

## `client.shipments`

- `client.shipments.cancel(shipmentID, options?)` → `void` — `DELETE /v1/shipments/{shipment_id}`
- `client.shipments.create(body, params, options?)` → `Shipment` — `POST /v1/shipments`
- `client.shipments.list(params?, options?)` → `Page<ShipmentPage>` — `GET /v1/shipments`
- `client.shipments.retrieve(shipmentID, options?)` → `Shipment` — `GET /v1/shipments/{shipment_id}`
- `client.shipments.update(shipmentID, body, options?)` → `Shipment` — `PATCH /v1/shipments/{shipment_id}`

```ts
await client.shipments.cancel("string");
```

## `client.shipments.events`

- `client.shipments.events.list(shipmentID, params?, options?)` → `Page<TrackingEventPage>` — `GET /v1/shipments/{shipment_id}/events`

```ts
for await (const item of await client.shipments.events.list("string")) {
  console.log(item);
}
```

## `client.tracking`

- `client.tracking.retrieve(trackingNumber, options?)` → `TrackingTimeline` — `GET /v1/tracking/{tracking_number}`

```ts
const result = await client.tracking.retrieve("string");
console.log(result);
```

## `client.webhookEndpoints`

- `client.webhookEndpoints.create(body, options?)` → `WebhookEndpoint` — `POST /v1/webhook-endpoints`
- `client.webhookEndpoints.list(params?, options?)` → `Page<WebhookEndpointPage>` — `GET /v1/webhook-endpoints`
- `client.webhookEndpoints.remove(endpointID, options?)` → `void` — `DELETE /v1/webhook-endpoints/{endpoint_id}`
- `client.webhookEndpoints.update(endpointID, body, options?)` → `WebhookEndpoint` — `PATCH /v1/webhook-endpoints/{endpoint_id}`

```ts
const result = await client.webhookEndpoints.create({
  description: "string",
  events: [
    "pickup.completed"
  ],
  url: "https://hooks.parcel-events.example/events"
});
console.log(result);
```

## Types

`Address` · `CreateLabelRequest` · `CreatePickupRequest` · `CreateShipmentRequest` · `CreateWebhookEndpointRequest` · `Label` · `LabelFormat` · `Money` · `Parcel` · `ParcelItem` · `Pickup` · `PickupPage` · `PickupWindow` · `RateQuote` · `RateQuoteRequest` · `RatesQuoteResponse` · `Shipment` · `ShipmentPage` · `ShipmentStatus` · `ShipmentStatusEvent` · `ShipmentStatusEventData` · `TrackingEvent` · `TrackingEventLocation` · `TrackingEventPage` · `TrackingTimeline` · `UpdateShipmentRequest` · `UpdateWebhookEndpointRequest` · `WebhookEndpoint` · `WebhookEndpointPage` · `WebhookEventType`
