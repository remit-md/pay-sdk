# payskill-fastapi

FastAPI middleware for x402 payments — both consumer and provider sides.

## Install

```bash
pip install payskill-fastapi
```

## Provider — Gate a route behind an x402 paywall

```python
from fastapi import FastAPI, Depends
from payskill_fastapi import require_payment, PaymentInfo

app = FastAPI()

@app.get("/api/data")
async def get_data(
    payment: PaymentInfo = Depends(
        require_payment(
            price=0.01,
            settlement="tab",
            provider_address="0x...",
        )
    ),
):
    return {"data": "premium", "paid_by": payment.from_address}
```

## Consumer — Auto-pay outbound x402 calls

```python
from fastapi import FastAPI, Request
from payskill import Wallet
from payskill_fastapi import PayMiddleware

app = FastAPI()
wallet = Wallet()

app.add_middleware(PayMiddleware, wallet=wallet, max_per_request=1.00)

@app.get("/forecast")
async def forecast(request: Request):
    resp = request.state.pay.fetch("https://api.example.com/forecast")
    return resp.json()
```

## License

MIT
