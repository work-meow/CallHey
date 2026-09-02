# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go test ./... && go build -trimpath -ldflags="-s -w" -o /tytut-signal .

FROM scratch
COPY --from=build /tytut-signal /tytut-signal
EXPOSE 8787
USER 65532:65532
ENTRYPOINT ["/tytut-signal"]
