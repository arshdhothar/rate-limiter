# --- build stage ---
# Full JDK + Maven, only used to compile -- this layer is discarded later,
# so its size doesn't affect the final image.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
# Downloads dependencies as a separate layer, so Docker can cache this step
# and skip re-downloading everything when only your source code changes.
RUN mvn -B dependency:go-offline
COPY src ./src
RUN mvn -B package -DskipTests

# --- run stage ---
# Just a JRE (no compiler, no Maven) -- much smaller than the build stage.
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=build /app/target/rate-limiter-0.1.0.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]