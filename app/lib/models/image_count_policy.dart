/// Typed representation of the image-count policy for a content slot.
///
/// LOCKED PRODUCT DECISION: a content slot uses either ONE or TWO images,
/// chosen by the backend ONCE per slot. Facebook and Threads always receive the
/// SAME count for a slot — the count is never randomized per platform.
///
/// The `random_1_or_2` policy is the default. Actual random selection and asset
/// persistence are implemented by the backend's content-generation pipeline;
/// this type only REPRESENTS the policy and validates the count the backend
/// reports, so the UI never invents or re-rolls a count on its own.
library;

enum ImageCountPolicy {
  randomOneOrTwo('random_1_or_2', 'Random 1-2 images', 1, 2),
  one('one', 'Always 1 image', 1, 1),
  two('two', 'Always 2 images', 2, 2);

  const ImageCountPolicy(this.wireValue, this.label, this.minImages, this.maxImages);

  /// Value used on the wire (matches the backend contract exactly).
  final String wireValue;

  /// Human-readable label for the settings screen.
  final String label;

  /// Inclusive bounds of the counts this policy may select.
  final int minImages;
  final int maxImages;

  /// The locked default policy.
  static const ImageCountPolicy defaultValue = ImageCountPolicy.randomOneOrTwo;

  /// All wire values, for offline validation in the client.
  static const List<String> wireValues = [
    'random_1_or_2',
    'one',
    'two',
  ];

  /// Lenient parse: returns null for an unknown value (caller decides).
  static ImageCountPolicy? tryParse(String? raw) {
    if (raw == null) return null;
    for (final policy in ImageCountPolicy.values) {
      if (policy.wireValue == raw) return policy;
    }
    return null;
  }

  /// Strict parse with the locked default as the fallback.
  static ImageCountPolicy parse(String? raw) => tryParse(raw) ?? defaultValue;

  /// Whether a backend-reported count is legal under this policy.
  bool allows(int count) => count >= minImages && count <= maxImages;

  /// Human explanation of what the backend will do with this policy.
  String get explanation => switch (this) {
        ImageCountPolicy.randomOneOrTwo =>
          'The backend picks 1 or 2 images once per slot; both platforms use the same count.',
        ImageCountPolicy.one => 'Every slot publishes exactly 1 image.',
        ImageCountPolicy.two => 'Every slot publishes exactly 2 images.',
      };
}
