FROM mcr.microsoft.com/dotnet/sdk:10.0-preview AS build
WORKDIR /src
COPY MafHarness.Web.csproj ./
RUN dotnet restore MafHarness.Web.csproj
COPY . ./
RUN dotnet publish MafHarness.Web.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0-preview AS runtime
WORKDIR /app
COPY --from=build /app/publish ./
EXPOSE 8788
ENV ASPNETCORE_URLS=http://+:8788
ENTRYPOINT ["dotnet", "MafHarness.Web.dll"]
