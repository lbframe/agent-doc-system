use engine::Engine;
use logging::init;
use foo_bar::Thing;

fn main() {
    let _engine = Engine::start();
    init();
    let _thing = foo_bar::Thing::name();
}
