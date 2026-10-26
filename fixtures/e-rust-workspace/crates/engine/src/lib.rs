pub struct Engine;

impl Engine {
    pub fn start() -> Self {
        Self
    }
}

#[cfg(test)]
mod tests {
    use testutil::fixture;

    #[test]
    fn starts() {
        let _ = fixture();
        let _ = super::Engine::start();
    }
}
