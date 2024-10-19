const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcrypt");
const axios = require("axios"); // Add axios for API requests

const app = express();

app.use(bodyParser.json());
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, "public")));

// MongoDB connection
mongoose
  .connect("mongodb://localhost:27017/carpool", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Define schemas and models
const userSchema = new mongoose.Schema({
  aadharId: { type: String, required: true },
  companyName: { type: String, required: true },
  employeeId: { type: String, required: true },
  vehicleNumber: { type: String, required: true },
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
});

const User = mongoose.model("User", userSchema);

const carpoolSchema = new mongoose.Schema({
  userName: { type: String, required: true },
  contactNo: { type: String, required: true },
  source: { type: Object, required: true }, // Store coordinates as an object
  sourceAddress: { type: String, required: true },
  destination: { type: Object, required: true },
  destinationAddress: { type: String, required: true },
  vehicleType: { type: String, required: true },
  userType: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});

const Carpool = mongoose.model("Carpool", carpoolSchema);

// Routes

// Signup route
app.post("/signup", async (req, res) => {
  try {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    const newUser = new User({
      aadharId: req.body.aadharId,
      companyName: req.body.companyName,
      employeeId: req.body.employeeId,
      vehicleNumber: req.body.vehicleNumber,
      username: req.body.username,
      password: hashedPassword,
    });
    await newUser.save();
    res.status(201).json({ message: "Signup successful!" });
  } catch (error) {
    console.error("Error during signup:", error);
    res.status(400).json({ message: "Error during signup: " + error.message });
  }
});

// Login route
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });

  if (!user) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  res.status(200).json({ message: "Login successful!" });
});

// Carpool request route
app.post("/find-ride", async (req, res) => {
  const {
    source,
    sourceAddress,
    destination,
    destinationAddress,
    vehicleType,
    userName,
    contactNo,
  } = req.body;

  try {
    const newRequest = new Carpool({
      userName,
      contactNo,
      source,
      sourceAddress,
      destination,
      destinationAddress,
      vehicleType,
      userType: "serviceTaker",
    });
    await newRequest.save();
    const matchedProvider = await matchRide(newRequest);

    if (matchedProvider) {
      // Fetch distance from OSRM
      const distance = await getDistanceFromOSRM(source, destination);
      const co2EmissionReduced = calculateCO2EmissionReduced(
        distance,
        vehicleType
      );
      const costTaken = calculateCost(distance, vehicleType);

      providerMatch = {
        userName: matchedProvider.userName,
        contactNo: matchedProvider.contactNo,
        source: matchedProvider.source,
        sourceAddress: matchedProvider.sourceAddress,
        destination: matchedProvider.destination,
        destinationAddress: matchedProvider.destinationAddress,
        vehicleType: matchedProvider.vehicleType,
        timestamp: matchedProvider.timestamp,
        co2EmissionReduced,
        costTaken,
      };

      takerMatch = {
        userName,
        contactNo,
        source,
        sourceAddress,
        destination,
        destinationAddress,
        vehicleType,
        co2EmissionReduced,
        costTaken,
      };

      res.status(200).send({ message: "Match found!" });
    } else {
      res
        .status(200)
        .send({ message: "No match found within the 10-minute window." });
    }
  } catch (err) {
    console.error("Error in find-ride:", err);
    res.status(500).send({ error: "Failed to submit request" });
  }
});

// Provide service route
app.post("/provide-service", async (req, res) => {
  const {
    source,
    sourceAddress,
    destination,
    destinationAddress,
    vehicleType,
    userName,
    contactNo,
  } = req.body;

  // Validate input
  if (
    !source ||
    !destination ||
    !vehicleType ||
    !userName ||
    !contactNo ||
    !sourceAddress ||
    !destinationAddress
  ) {
    return res.status(400).send({ error: "All fields are required." });
  }

  try {
    const newService = new Carpool({
      userName,
      contactNo,
      source,
      sourceAddress,
      destination,
      destinationAddress,
      vehicleType,
      userType: "serviceProvider",
    });
    await newService.save();
    res.status(200).send({ message: "Service offer submitted successfully!" });
  } catch (err) {
    console.error("Error saving service offer:", err);
    res.status(500).send({ error: "Failed to submit service offer" });
  }
});

// Function to fetch distance from OSRM API
const getDistanceFromOSRM = async (source, destination) => {
  try {
    const response = await axios.get(
      `http://router.project-osrm.org/route/v1/driving/${source.lng},${source.lat};${destination.lng},${destination.lat}?overview=false`
    );
    const distance = response.data.routes[0].distance / 1000; // Convert meters to kilometers
    return distance;
  } catch (error) {
    console.error("Error fetching distance from OSRM:", error);
    throw new Error("Failed to fetch distance from OSRM");
  }
};

// CO2 Emission calculation
const calculateCO2EmissionReduced = (distance, vehicleType) => {
  const co2PerKm = {
    bike: 0.08, // kg CO2 per km
    car: 0.12,
    sedan: 0.18,
  };
  return co2PerKm[vehicleType] * distance;
};

// Cost calculation based on distance and vehicle type
const calculateCost = (distance, vehicleType) => {
  const costPerKm = {
    bike: 2, // ₹ per km
    car: 5,
    sedan: 8,
  };
  return costPerKm[vehicleType] * distance;
};

// Matching logic
const minutesToMilliseconds = (minutes) => minutes * 60 * 1000;

const matchRide = async (serviceTaker) => {
  try {
    const tenMinutesAgo = new Date(Date.now() - minutesToMilliseconds(10));

    const providers = await Carpool.find({
      userType: "serviceProvider",
      timestamp: { $gte: tenMinutesAgo },
    });

    // Filter providers based on distance using OSRM
    const matchedProvider = await Promise.all(
      providers.map(async (provider) => {
        const distance = await getDistanceFromOSRM(
          serviceTaker.source,
          provider.source
        );
        const isSameDestination =
          provider.destination.lat === serviceTaker.destination.lat &&
          provider.destination.lng === serviceTaker.destination.lng;

        return distance <= 2 &&
          provider.vehicleType === serviceTaker.vehicleType &&
          isSameDestination
          ? provider
          : null;
      })
    ).then((results) => results.find((provider) => provider !== null));

    return matchedProvider;
  } catch (err) {
    console.error("Error matching ride:", err);
    return null;
  }
};

let takerMatch = null;
let providerMatch = null;

app.get("/get-taker-match", (req, res) => {
  if (takerMatch) {
    res.status(200).json(takerMatch);
  } else {
    res.status(404).json({ message: "No match found for taker." });
  }
});

// Route to get provider's match
app.get("/get-provider-match", (req, res) => {
  if (providerMatch) {
    res.status(200).json(providerMatch);
  } else {
    res.status(404).json({ message: "No match found for provider." });
  }
});

// Server start
app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
